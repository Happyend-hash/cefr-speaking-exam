/**
 * Post-deploy smoke test.
 *
 * Every check here corresponds to a failure that actually reached production on
 * this project and was not caught by anything. Run it after each deploy:
 *
 *   npm run smoke -- https://cefr-speaking-exam-production.up.railway.app
 *   npm run smoke                      # defaults to SMOKE_URL, else localhost
 *
 * Exits non-zero if any check fails, so it can gate a deploy in CI.
 */

const BASE = (process.argv[2] || process.env.SMOKE_URL || 'http://localhost:5000').replace(/\/$/, '');

const results = [];
let failed = 0;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function get(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, { redirect: 'follow', ...options });
  const text = await response.text();
  return { status: response.status, text, headers: response.headers };
}

async function run() {
  console.log(`\nSmoke testing ${BASE}\n`);

  // 1. The server is reachable at all. A 502 here means the container is down,
  //    or the public domain's target port does not match the port the app binds.
  let health;
  try {
    health = await get('/api/health');
  } catch (error) {
    record('API reachable', false, `${error.message} (502/timeout usually means a domain target-port mismatch)`);
    return finish();
  }

  record(
    'GET /api/health returns 200',
    health.status === 200,
    health.status === 502
      ? 'got 502 — check Settings → Networking → Target port matches PORT'
      : `status ${health.status}`
  );

  let healthJson = {};
  try {
    healthJson = JSON.parse(health.text);
  } catch { /* reported below */ }
  record('Health payload says OK', healthJson.status === 'OK', `got ${JSON.stringify(healthJson).slice(0, 80)}`);

  // 2. The client is served.
  const index = await get('/');
  const servesHtml = index.status === 200 && /<div id="root"|<body/i.test(index.text);
  record('GET / serves the client', servesHtml, `status ${index.status}`);

  // 3. Every stylesheet actually contains compiled CSS.
  //    Raw @tailwind directives shipped once and left the whole site unstyled.
  const cssHrefs = [...index.text.matchAll(/<link[^>]+href="([^"]+\.css)"/g)].map(m => m[1]);
  record('Client references a stylesheet', cssHrefs.length > 0, `${cssHrefs.length} found`);

  for (const href of cssHrefs) {
    const css = await get(href.startsWith('http') ? href : href);
    const hasRawDirectives = css.text.includes('@tailwind');
    const ruleCount = (css.text.match(/\{/g) || []).length;
    record(`Stylesheet ${href} is compiled`, !hasRawDirectives, hasRawDirectives ? 'contains raw @tailwind directives' : '');
    record(`Stylesheet ${href} has real rules`, ruleCount >= 20, `${ruleCount} rules`);
  }

  // 4. No script points at a developer's own machine.
  const jsSrcs = [...index.text.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map(m => m[1]);
  for (const src of jsSrcs) {
    const js = await get(src);
    const pointsAtLocalhost = /localhost:\d+|127\.0\.0\.1:\d+/.test(js.text);
    record(`Script ${src} has no localhost URL`, !pointsAtLocalhost, pointsAtLocalhost ? 'would break for every real visitor' : '');
  }

  // 5. Protected routes actually enforce auth — a stub would return 200.
  const exams = await get('/api/exam');
  record('GET /api/exam requires auth', exams.status === 401, `status ${exams.status}`);

  // 6. Endpoints the client calls exist. A 404 here is the signup mismatch
  //    that silently broke registration.
  for (const path of ['/api/auth/signup', '/api/auth/login']) {
    const probe = await get(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    record(`POST ${path} exists`, probe.status !== 404, `status ${probe.status}`);
  }

  // 7. Routes must be implemented, not placeholders.
  const exam404 = await get('/api/exam/health-probe-nonexistent');
  record('Exam routes are implemented', !exam404.text.includes('route stub'), exam404.text.includes('route stub') ? 'still returning stub responses' : '');

  finish();
}

function finish() {
  const total = results.length;
  console.log(
    failed === 0
      ? `\n✓ All ${total} checks passed\n`
      : `\n✗ ${failed} of ${total} checks failed\n`
  );
  process.exit(failed === 0 ? 0 : 1);
}

run().catch(error => {
  console.error(`\n✗ Smoke test crashed: ${error.message}\n`);
  process.exit(1);
});
