# Operations

Everything needed to run, deploy and not re-break this project.

---

## Deploying

Railway builds from the `Dockerfile` on the `main` branch, and a push to `main`
starts the build on its own. Nothing else is required.

### When a push does not start a build

This has happened, and it took two separate faults to cause it — so check both,
in this order, at **Service → Settings → Source**:

1. **A red *GitHub Repo not found*** under "Branch connected to production" means
   Railway's GitHub App has lost sight of the repository. Repair it on GitHub, not
   on Railway: <https://github.com/settings/installations> → **Railway App** →
   **Configure** → *Repository access* → make sure `cefr-speaking-exam` is
   selected → **Save**. Railway then shows the branch name (`main`) in place of
   the error.
2. **"Auto deploy is disabled"** beside the branch. Click **Enable**. The line
   should end up reading *Auto deploys when pushed to GitHub*.

Fixing the first does not fix the second. With the repository reconnected but
auto-deploy still switched off, pushes stay silent and the settings page otherwise
looks entirely healthy — which is what made this take so long to find.

To ship a commit without waiting on any of that — the manual route, which works
even while the connection is broken:

**Service → Settings → Source → Check for updates → Update → Yes**

After every deploy:

```bash
npm run smoke -- https://cefr-speaking-exam-production.up.railway.app
```

---

## The checks, and what each one is for

Every check exists because the corresponding failure reached production here and
nothing caught it.

| Command | Catches |
|---|---|
| `npm run check:api` | A client call with no matching server route. Needs no database or network — run it before every commit. |
| `npm run smoke -- <url>` | A deployment that is up but wrong: unstyled CSS, a bundle pointing at localhost, unauthenticated protected routes, missing endpoints, a 502 from a port mismatch. |
| Server startup warnings | Placeholder API keys, weak `JWT_SECRET`, missing `REFRESH_TOKEN_SECRET`. Printed on boot — read the deploy logs. |

### The failures these replace

1. **Domain target port 8080, app listening on 5000.** Railway returned 502
   while the container was perfectly healthy. `npm run smoke` now reports this
   explicitly.
2. **Tailwind never compiled.** The stylesheet shipped raw `@tailwind`
   directives, which browsers ignore, so the site rendered unstyled. There is now
   no build step to forget — see below.
3. **`API_URL = 'http://localhost:5000/api'`.** Every request from a real
   visitor went to their own machine. The smoke test fails on any `localhost` in
   a served script.
4. **Client called `/api/auth/signup`; server defined `/api/auth/register`.**
   `npm run check:api` compares the two sides directly.
5. **`REFRESH_TOKEN_SECRET` unset.** `jwt.sign` throws on an undefined secret, so
   every login 500'd. It now falls back to a value derived from `JWT_SECRET` and
   warns loudly.

---

## The client has no build step

`public/` is served directly: `index.html`, `app.js`, `styles.css`. Plain ES2020
and plain CSS — no bundler, no transpiler, no Tailwind compiler.

This is deliberate. The previous client was a Create React App build whose
compiled output was committed to the repo. The committed output drifted from its
source, and because nothing rebuilt it, two serious bugs shipped inside it and
survived every deploy. With no build step there is no output to drift.

To change the client, edit `public/app.js` and reload. No install, no rebuild.

`frontend/` holds the old CRA source, recovered from the production source maps
and kept for reference. **It is not built and not served.** If you ever move back
to a bundled client, make the Dockerfile run the build so compiled output is
never committed by hand.

---

## Seeding exams

```bash
npm run seed
```

Creates or updates the six CEFR speaking exams (A1–C2, three tasks each).
Idempotent — safe to re-run, including against production. Exams need an author,
so it reuses an existing admin or creates `SEED_ADMIN_EMAIL`.

Nothing appears on the dashboard until this has been run at least once.

---

## How audio and transcription work

Recording happens in the browser (`MediaRecorder`) and uploads to
`POST /api/exam/results/:resultId/tasks/:taskNumber` as multipart form data,
alongside a transcript and a duration.

**Storage is MongoDB GridFS**, not the filesystem. Railway containers are
ephemeral, so anything written to disk disappears on redeploy. Recordings are
capped at 10 MB each and streamed back, owner-only, from
`GET /api/exam/audio/:audioKey`.

**Transcription has two paths**, chosen automatically:

- `OPENAI_API_KEY` set → Whisper transcribes server-side. Accurate, works in
  every browser, costs per minute of audio.
- Not set → the browser's `SpeechRecognition` transcript is used. Free, but only
  Chrome and Edge support it properly; Firefox users would submit no transcript.

Claude's API cannot accept audio, which is why this step is separate. Evaluation
always runs on text.

---

## Grading

`POST /api/exam/results/:resultId/submit` evaluates every answered task through
`AIEvaluationService`, then computes an overall score and CEFR level.

If one task fails to evaluate, the others still count and the recordings are
kept, so an attempt is never lost to a transient API error. If *every* task
fails, the attempt returns to `submitted` and the response says why — almost
always a bad `CLAUDE_API_KEY`.

Score bands are defined in `ExamResult.determineCEFRLevel()`:
A1 <35, A2 35–49, B1 50–64, B2 65–74, C1 75–84, C2 85+.

---

## Required configuration

See `.env.example` for the annotated list. The short version:

| Variable | Without it |
|---|---|
| `MONGODB_URI` | Server exits on boot |
| `JWT_SECRET` | Cannot issue tokens; a weak value means forgeable logins |
| `CLAUDE_API_KEY` | Everything works except grading, which fails at submission |
| `OPENAI_API_KEY` | Transcription falls back to Chrome/Edge only |
| `STRIPE_SECRET_KEY` | Payment endpoints fail |
| `TELEGRAM_CONTACT` | The top-up page tells students to ask their teacher, with nobody to click |

---

## Who may take a mock

Every attempt costs real money — transcription on each upload, marking and
pronunciation on submit — so attempts are rationed. Two separate controls, and
keeping them separate is deliberate:

- **`access.blocked`** — a decision about the person. It stops them outright,
  stops a resume as well as a new attempt, and leaves the mocks they have alone
  so nothing is lost when they come back.
- **`subscription.examsRemaining`** — a balance. One free mock on a new account;
  everything after that is granted by the teacher in **Admin → Students**.

A credit is spent when an attempt is **created**, not when it is submitted:
that is the moment the spending starts, and it means a student who reloads or
loses their connection mid-test is not charged twice. Deleting an attempt that
was never spoken into hands the credit back. Teachers and admins are never
charged and never blocked, so blocking the whole class cannot lock the teacher
out of their own product.

Payment happens outside the app. The flow is: the student runs out → the
top-up page shows them the Telegram contact from `TELEGRAM_CONTACT` and their
own registered email to quote → they pay the teacher directly → the teacher
adds mocks on that student's row → the student sees a confirmation on their
dashboard the next time they open it.

**When the link escapes.** Admin → Students → *Block every student* stops the
whole class in one request; it touches `role: 'student'` only, and refuses to
run unless the count it was shown still matches. Let people back in one at a
time with *Set to* and *Unblock*. Accounts created before this existed still
carry the old free allowance of 2, because nothing was counting then — blocking
everyone is what stops those being spent.

---

## Known gaps

- `routes/payment.js` is still a stub. Nothing in the app takes money: access is
  granted by hand after a payment made outside it, which is the honest model
  while the teacher is collecting payment in person.
- No automated test suite; `npm test` expects a `test/` directory that does not exist.
- Email verification and password reset are implemented in `AuthService` but need SMTP configured.
- Appeals are recorded on the result but there is no reviewer interface.
