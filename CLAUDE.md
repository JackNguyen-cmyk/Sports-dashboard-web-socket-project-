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

## Backlog — reviewed, not yet done

Ranked. Recorded 2026-09-07 from a full review; none are currently breaking.

**1. WebSocket heartbeat (ping/pong).** TCP connections die silently — a slept
laptop, a dropped wifi, a NAT timeout, and no FIN ever reaches the server. The
socket stays in `wss.clients` with `readyState === OPEN` forever, so broadcasts
are serialised and sent to nothing, and `wss.clients.size` lies. Standard `ws`
fix: every 30s mark each client dead and `ping()`; a `pong` marks it alive
again; anything still dead next cycle gets `terminate()`. Add `interval.unref()`
so the timer doesn't hold the process open, and `clearInterval` on `wss.close`.

**2. Error responses leak database internals.** `routes/matches.js` sends
`JSON.stringify(error.message)` to clients. `JSON.stringify` on a string only
adds quotes, and a Postgres error can expose table, column and constraint
names. Log server-side, return a generic message.

**3. Zod errors are unreadable.** `JSON.stringify(parsed.error)` produces an
escaped blob. Use `parsed.error.issues.map(i => ({field: i.path.join('.'),
message: i.message}))`, or `z.flattenError(err).fieldErrors` for a
`{field: [messages]}` shape that maps onto form fields.

**4. No graceful shutdown.** On SIGTERM/SIGINT the pg pool and ws server are
dropped mid-flight. Close server, then `wss.close()`, then `pool.end()`.

**5. Unused schemas.** `matchIdParamSchema` and `updateScoreSchema` exist with
no endpoints — no `GET /matches/:id`, no score update. `commentary` is also
still an empty table with no code touching it.

**6. No route tests.** Only `utils/match-status.js` is tested. Routes have the
most branching. `node:test` + `fetch` against `app.listen(0)` (port 0 = any
free port) covers 400/201/500 without new dependencies.

**7. `.idea/` is not in the root `.gitignore`.** JetBrains config at the repo
root is unignored. One line fixes it.

**8. Express 5 forwards async errors automatically** (verified) — unlike
Express 4, a throwing `async` handler reaches error middleware without a
wrapper. The explicit `try/catch` blocks are still fine, but a single error
middleware could replace the duplicated 500 handling.

### Parked query-handling decisions

- Unknown query params are silently dropped (`?sport=football` returns every
  sport with no error). `.strict()` on `listMatchesQuerySchema` would reject
  them. Tradeoff: catches client typos like `?limti=5` vs tolerating extra
  params.
- `?sport=` should probably become a real filter; `sport` is already stored.
- The limit cap is expressed twice: `MAX_LIMIT` clamps in the route while the
  schema already rejects >100. The route clamp is unreachable for user input.
