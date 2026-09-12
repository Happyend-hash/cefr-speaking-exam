/**
 * Static contract check between the client and the API.
 *
 * The client called /api/auth/signup while the server only defined
 * /api/auth/register, and /api/exam/list against a server that only defined
 * /api/exam. Both were 404s in production that no test caught, because nothing
 * ever compared the two sides. This script does exactly that, without needing a
 * database, a network, or installed dependencies.
 *
 *   npm run check:api
 *
 * Exits non-zero when the client calls a route the server does not define.
 *
 * Limit worth knowing: a call that collides with a parameterised route is
 * reported as matching, because it genuinely does match — GET /api/exam/list
 * reaches the /api/exam/:id handler and fails there on a bad id, rather than
 * 404ing. This check proves a route exists, not that it does what you meant.
 * The smoke test covers behaviour against a running deployment.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

// ---- 1. Which router file is mounted at which prefix ----------------------

const server = read('server.js');

const importedRouters = new Map(); // local name -> file path
for (const match of server.matchAll(/import\s+(\w+)\s+from\s+['"]\.\/(routes\/[\w.-]+\.js)['"]/g)) {
  importedRouters.set(match[1], match[2]);
}

const mounts = []; // { prefix, file }
for (const match of server.matchAll(/app\.use\(\s*['"](\/api\/[\w-]*)['"]\s*,\s*([^)]*)\)/g)) {
  const [, prefix, rest] = match;
  const routerName = rest.split(',').map(s => s.trim()).find(name => importedRouters.has(name));
  if (routerName) mounts.push({ prefix, file: importedRouters.get(routerName) });
}

// ---- 2. Every route each router defines -----------------------------------

const routes = []; // { method, pattern }
for (const { prefix, file } of mounts) {
  const source = read(file);
  for (const match of source.matchAll(/router\.(get|post|put|patch|delete)\(\s*['"]([^'"]*)['"]/g)) {
    const [, method, routePath] = match;
    const full = (prefix + (routePath === '/' ? '' : routePath)).replace(/\/$/, '') || prefix;
    routes.push({ method: method.toUpperCase(), pattern: full });
  }
}

// Routes declared directly on the app (the health check, for instance).
for (const match of server.matchAll(/app\.(get|post)\(\s*['"](\/api\/[^'"]*)['"]/g)) {
  routes.push({ method: match[1].toUpperCase(), pattern: match[2] });
}

// ---- 3. Every call the client makes ---------------------------------------

const client = read('public/app.js');
const calls = []; // { method, path }

// Each string form is matched separately: a template literal may legitimately
// contain quotes inside its ${...} expressions, so a combined character class
// would truncate the path at the first inner quote.
for (const match of client.matchAll(
  /api\(\s*(?:`([^`]*)`|'([^']*)'|"([^"]*)")\s*(?:,\s*\{([^}]*)\})?/g
)) {
  const rawPath = match[1] ?? match[2] ?? match[3];
  const options = match[4] || '';
  const methodMatch = options.match(/method:\s*['"](\w+)['"]/);
  const method = (methodMatch ? methodMatch[1] : 'GET').toUpperCase();

  for (const expanded of expandPath(rawPath)) {
    calls.push({ method, path: '/api' + expanded.replace(/\/$/, '') });
  }
}

/**
 * Turn one template-literal path into every concrete path it can produce.
 *
 * A `${...}` holding string literals — `${isSignup ? 'signup' : 'login'}` — is a
 * choice between fixed endpoints, so each option is checked as a real path. This
 * matters: the bug that broke registration was a wrong literal inside exactly
 * such an expression, and collapsing it to a wildcard would hide it. Only an
 * expression with no string literals (a genuine id) becomes `:param`.
 */
function expandPath(rawPath) {
  const parts = rawPath.split(/(\$\{[^}]*\})/);
  let variants = [''];

  for (const part of parts) {
    if (!part.startsWith('${')) {
      variants = variants.map(v => v + part);
      continue;
    }
    const literals = [...part.matchAll(/['"]([^'"]*)['"]/g)].map(m => m[1]);
    const options = literals.length ? literals : [':param'];
    variants = variants.flatMap(v => options.map(option => v + option));
  }
  return [...new Set(variants)];
}

// ---- 4. Compare -----------------------------------------------------------

/**
 * Compare a client call path with a server route pattern segment by segment.
 *
 * Either side may carry a parameter: the server declares `:resultId`, and a
 * client path built from a template literal yields `:param`. A segment matches
 * when the literals are equal, or when either side is a parameter. Comparing
 * with a regex in one direction only would miss the second case.
 */
const pathsMatch = (callPath, routePattern) => {
  const a = callPath.split('/');
  const b = routePattern.split('/');
  if (a.length !== b.length) return false;
  return a.every((segment, i) =>
    segment === b[i] || segment.startsWith(':') || b[i].startsWith(':'));
};

let failures = 0;
console.log('\nAPI contract check\n');
console.log(`  ${routes.length} server routes, ${calls.length} client calls\n`);

const seen = new Set();
for (const call of calls) {
  const key = `${call.method} ${call.path}`;
  if (seen.has(key)) continue;
  seen.add(key);

  const matched = routes.some(
    route => route.method === call.method && pathsMatch(call.path, route.pattern)
  );

  console.log(`  ${matched ? '✓' : '✗'} ${key}`);
  if (!matched) {
    failures++;
    const samePath = routes.filter(r => pathsMatch(call.path, r.pattern));
    if (samePath.length) {
      console.log(`      path exists but not for ${call.method}: ${samePath.map(r => r.method).join(', ')}`);
    } else {
      const near = routes
        .filter(r => r.pattern.startsWith(call.path.split('/').slice(0, 3).join('/')))
        .map(r => `${r.method} ${r.pattern}`);
      if (near.length) console.log(`      no match. Nearby routes: ${near.join(', ')}`);
    }
  }
}

if (failures === 0) {
  console.log('\n✓ Every client call maps to a defined route\n');
  process.exit(0);
}
console.log(`\n✗ ${failures} client call(s) have no matching route — these would 404 in production\n`);
process.exit(1);
