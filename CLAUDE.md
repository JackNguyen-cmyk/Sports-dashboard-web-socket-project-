# Sports dashboard — WebSocket project

Real-time sports app: Express HTTP API + `ws` WebSocket server, Neon Postgres
via Drizzle ORM, Zod for validation. Plain JavaScript (ESM), not TypeScript.

## Project layout

**The project root is `src/`, not the repository root.** `package.json`,
`node_modules`, `.env` and `drizzle.config.js` all live in `src/`. Every npm
command must be run from there:

```bash
cd src
npm run dev        # node --watch index.js
npm test           # node --test
npm run db:generate / db:migrate
```

Running `npm install` from the repository root creates a stray root
`package.json` and `node_modules` that nothing uses — a mistake that has
happened several times. If you hit "Could not read package.json", you are in
the wrong directory.

## Learning mode

I'm building this project to learn backend engineering, not just to ship it.
Please follow these rules for all work on this codebase:

1. Before writing or changing code, briefly explain *why* the change is
   needed and what approach you're taking — not just what you're about to do.

2. When you introduce a concept, pattern, or library I haven't clearly used
   before in this codebase (e.g. a new Zod feature, a Drizzle query pattern,
   an Express middleware technique), explain it in plain terms before or
   alongside the code — don't assume I already know it.

3. Prefer smaller, reviewable diffs over large multi-file rewrites, so I can
   follow what changed and why, even if a bigger refactor would be more
   "efficient."

4. When there's a design tradeoff (e.g. fail loudly vs. fail silently,
   validate at the boundary vs. validate again at point of use), point out
   the tradeoff explicitly and give me your recommendation — don't just pick
   one silently.

5. If you notice a fragile assumption or hidden dependency between files
   (like a function that only works because another file guarantees clean
   input), flag it even if it's not currently broken — I want to learn to
   spot these, not just fix them reactively.

6. Comments in code should explain *why*, not just *what* — especially for
   non-obvious invariants or edge cases.

Don't slow down every single response with a lecture — use judgment on depth
based on how novel or risky the change is. Routine, well-understood changes
can just be made directly.

### Learning log

Mistakes I make, questions I ask, and anything with teaching value go in
`LEARNING.md`, not here. Keep `CLAUDE.md` for instructions and open work;
`LEARNING.md` is the record of what went wrong and what it taught.

It has two halves, and most findings belong in the first:

- **Lessons**, grouped by the concept they illustrate rather than
  chronologically: the actual bug, why it broke, the general rule.
- **Debugging stories**, for anything that took real diagnosis, written as
  symptom → investigation → root cause → fix → evidence.

I want to be able to talk about this project in interviews — "what went wrong
and how did you find it" is the usual question, and specifics are what make an
answer credible. So keep the concrete details: the actual error text or
SQLSTATE, the wrong assumption that caused it, how it was isolated, and a
number where one exists (49 requests allowed versus 25, 5 of 18 tests failing
against the old code). Write down *how* it was diagnosed, not just the
conclusion — the reasoning is the part worth retelling. A finding with no
number and no method is not worth much.

## Git

Work and commit directly on `main`; no feature branches unless I ask. Claude
does not push `main` — I run `git push` myself.

## What is wired up

Audited 2026-09-08. Request path:

```
HTTP  →  express.json  →  securityMiddleware()  →  GET /
                                              →  /matches router
                                              →  /matches/:id/commentary router
WS    →  server.listen (shared HTTP server)  →  /ws  →  wsArcjet check  →  heartbeat  →  welcome
                                                   →  {type:'subscribe', matchId}  →  matchSubscribers
POST /matches  →  Zod  →  getMatchStatus  →  db.insert  →  broadcastMatchCreated  →  all clients
POST /matches/:id/commentary  →  Zod  →  db.insert  →  broadcastCommentaryCreated
                                                       →  subscribers of that match only
```

Connected and verified end to end: Express + `ws` share one HTTP server;
`GET`/`POST /matches` and `GET`/`POST /matches/:id/commentary` hit Neon through
Drizzle; creating a match broadcasts to every socket, while commentary goes only
to sockets that sent `{type:'subscribe', matchId}`; Arcjet rate limits both HTTP
and upgrades; the heartbeat reaps dead sockets.

Arcjet and the APM Insight agent can each be taken out of the path deliberately
— `ARCJET_ENABLED=false` and `APMINSIGHT_AGENT_DISABLE=true`. Both are off for
load-test runs; see `load-tests/README.md`.

**Exists but is not connected to anything:**

- `matchesRelations` / `commentaryRelations` — `db/db.js` calls `drizzle(pool)`
  without `{ schema }`, so `db.query` is empty and the relational API is
  unavailable. The relations are currently dead code.
- `syncMatchStatus` — called only by its own tests, never by the app. Nothing
  moves a match from scheduled to live to finished after creation.
- `updateScoreSchema` — no score-update endpoint. (`matchIdParamSchema` is now
  used, by the commentary router.)
- `pool` — exported from `db/db.js`, imported nowhere. Needed for shutdown.

## Backlog

Forward-looking work — scaling, deployment, webhooks, real data ingestion — lives
in `ROADMAP.md`. What follows is the short list of known defects in the code as it
stands.

**Two of these now crash the process and are proven, not suspected** (`ROADMAP.md`
Stage 0): `socket.on('error')` and `socket.on('close')` are registered after the
awaited Arcjet check in `ws/server.js`, and `db/db.js` has no `pool.on('error')`.
Fix those before anything else.

Ranked. The four items introduced by the `securityMiddleware()` refactor are
resolved (verified 2026-09-08): the inline middleware is gone, `securityMiddleware()`
is registered before `GET /`, the bare `catch{` now binds `error`, and with only
one HTTP middleware left the fail-open/fail-closed split is a stated policy
rather than a disagreement — HTTP fails open, WS fails closed, both commented at
the call site.

**1. `routes/matches.js` leaks database internals.** Four sites send
`JSON.stringify(error.message)` or `JSON.stringify(parsed.error)` — lines 15, 24,
31 and 67. `JSON.stringify` on a string only adds quotes, and a Postgres error
can expose table, column and constraint names. `routes/commentary.js` already
does this correctly: log server-side, return a generic message, and map Zod
issues with its `zodDetails` helper. Copy that pattern over.

**2. No graceful shutdown.** On SIGTERM/SIGINT the pg pool and ws server are
dropped mid-flight. Close server, then `wss.close()`, then `pool.end()` — this
is what the unused `pool` export is for.

**3. No route tests.** Only `utils/match-status.js` is tested. `node:test` plus
`fetch` against `app.listen(0)` (port 0 = any free port) covers 400/201/500
without new dependencies.

**4. `.idea/` is not in the root `.gitignore`.**

**5. Express 5 forwards async errors automatically** (verified) — unlike
Express 4, a throwing `async` handler reaches error middleware without a
wrapper, so a single error middleware could replace the duplicated 500 blocks.

**6. `ws/arcjet.js` exports `httpArcjet` and `securityMiddleware`**, neither of
which is WebSocket-specific. `src/config/arcjet.js` would be a more honest home.

### Known characteristic, not a bug

Arcjet's sliding window is evaluated before it increments, so simultaneous
requests can all pass: ten WebSocket upgrades opened at once were all allowed,
while opened sequentially the 6th onward were refused with 1013. It throttles
sustained load, not a single instantaneous burst.

### Parked query-handling decisions

- Unknown query params are silently dropped (`?sport=football` returns every
  sport with no error). `.strict()` would reject them. Tradeoff: catches client
  typos like `?limti=5` vs tolerating extra params.
- `?sport=` should probably become a real filter; `sport` is already stored.
- The limit cap is expressed twice: `MAX_LIMIT` clamps in the route while the
  schema already rejects >100, making the route clamp unreachable for user input.
