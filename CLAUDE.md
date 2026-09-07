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

## Git

Work and commit directly on `main`; no feature branches unless I ask. Claude
does not push `main` — I run `git push` myself.

## What is wired up

Audited 2026-09-07. Request path:

```
HTTP  →  express.json  →  arcjet (inline, index.js)  →  GET /
                                                     →  securityMiddleware()  →  /matches router
WS    →  server.listen (shared HTTP server)  →  /ws  →  wsArcjet check  →  heartbeat  →  welcome
POST /matches  →  Zod  →  getMatchStatus  →  db.insert  →  broadcastMatchCreated  →  all clients
```

Connected and verified end to end: Express + `ws` share one HTTP server;
`GET`/`POST /matches` hit Neon through Drizzle; creating a match broadcasts to
connected sockets; Arcjet rate limits both HTTP and upgrades; the heartbeat
reaps dead sockets.

**Exists but is not connected to anything:**

- The `commentary` table — created and migrated, referenced by no code at all.
  The live-commentary feature is entirely unbuilt.
- `matchesRelations` / `commentaryRelations` — `db/db.js` calls `drizzle(pool)`
  without `{ schema }`, so `db.query` is empty and the relational API is
  unavailable. The relations are currently dead code.
- `syncMatchStatus` — called only by its own tests, never by the app. Nothing
  moves a match from scheduled to live to finished after creation.
- `matchIdParamSchema` and `updateScoreSchema` — no `GET /matches/:id` and no
  score-update endpoint.
- `pool` — exported from `db/db.js`, imported nowhere. Needed for shutdown.

## Backlog

Ranked. Items 1–4 were introduced by the `securityMiddleware()` refactor.

**1. Arcjet protection is registered twice.** `index.js` still has the inline
`app.use(async (req,res,next) => ...)` *and* now `app.use(securityMiddleware())`.
Every request under `/matches` calls `protect()` twice, so it consumes the rate
limit twice and doubles the calls billed to Arcjet. Measured against a 50-per-10s
window: `/` allowed 49 requests, `/matches` allowed 25. Delete the inline one.

**2. `securityMiddleware()` is registered after `GET /`.** Express matches in
order, so the root route never reaches it — it is covered only by the inline
middleware. Once the inline one is deleted, `/` becomes unprotected. Register
security before any route.

**3. `catch{ console.error("...", error) }` throws.** The bare catch binds no
variable, so `error` is undefined and the handler raises
`ReferenceError: error is not defined` (verified) — turning an Arcjet outage
into an unhandled rejection. Needs `catch (error) {`.

**4. The two middlewares disagree on failure.** The inline one fails OPEN
(logs, calls `next()`); `securityMiddleware()` fails CLOSED (503). The WS path
also fails closed, deliberately — an unvetted socket lives for hours whereas a
slipped request is over in milliseconds. Pick a policy for HTTP and state it.

**5. Error responses leak database internals.** `routes/matches.js` sends
`JSON.stringify(error.message)`. `JSON.stringify` on a string only adds quotes,
and a Postgres error can expose table, column and constraint names. Log
server-side, return a generic message.

**6. Zod errors are unreadable.** `JSON.stringify(parsed.error)` produces an
escaped blob. Use `parsed.error.issues.map(i => ({field: i.path.join('.'),
message: i.message}))`, or `z.flattenError(err).fieldErrors`.

**7. No graceful shutdown.** On SIGTERM/SIGINT the pg pool and ws server are
dropped mid-flight. Close server, then `wss.close()`, then `pool.end()` — this
is what the unused `pool` export is for.

**8. No route tests.** Only `utils/match-status.js` is tested. `node:test` plus
`fetch` against `app.listen(0)` (port 0 = any free port) covers 400/201/500
without new dependencies.

**9. `.idea/` is not in the root `.gitignore`.**

**10. Express 5 forwards async errors automatically** (verified) — unlike
Express 4, a throwing `async` handler reaches error middleware without a
wrapper, so a single error middleware could replace the duplicated 500 blocks.

**11. `ws/arcjet.js` exports `httpArcjet` and `securityMiddleware`**, neither of
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
