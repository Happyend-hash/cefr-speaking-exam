# Frontend

React source for the CEFR Speaking Exam client.

This source was recovered from the production build's source maps. Previously only
the compiled output in `/public` was committed, and the source was lost.

## Important build notes

Two bugs existed in the previously deployed bundle and are fixed here:

1. **`API_URL` pointed at `http://localhost:5000/api`**, so every API call failed for
   real visitors. It is now the relative path `/api` — the Express server serves both
   the static client and the API from the same origin, so no host or CORS config is needed.

2. **Tailwind was never compiled.** The shipped stylesheet contained raw
   `@tailwind base; @tailwind components; @tailwind utilities;` directives, which
   browsers ignore, so the site rendered completely unstyled.

`src/tailwind-output.css` is a hand-written stylesheet covering exactly the utility
classes this app uses, with Tailwind v3's values. It is installed as the compiled
stylesheet in `/public/static/css/`. This exists because the build environment had no
npm access. **If you rebuild with the real toolchain, that file becomes unnecessary.**

## Rebuilding properly

```bash
cd frontend
npm install
npm run build
cp -r build/* ../public/
```

`tailwind.config.js` and `postcss.config.js` are configured, so `npm run build` will
compile Tailwind correctly. After rebuilding, verify the emitted CSS in
`public/static/css/` contains real rules and not `@tailwind` directives.
