# Learning log

Mistakes made while building this project, grouped by what they teach. Each
entry is a real bug that actually occurred here, not a hypothetical.

## Node ESM and module resolution

**Extensionless imports fail.** `import { db } from '../db/db'` throws
`ERR_MODULE_NOT_FOUND`. Happened three times: `../validation/matches`,
`../db/schema`, `./arcjet`. In ESM the extension is part of the specifier —
CommonJS guessed it for you, ESM does not. Always write `.js`.

**`WebSocket.Server` does not exist in the ESM build of `ws`.** `import
WebSocket from 'ws'` then `new WebSocket.Server(...)` throws "not a
constructor". Use the named export: `import { WebSocketServer } from 'ws'`.
A package's CommonJS and ESM entry points can expose different shapes.

**npm commands run against the *current* directory.** Running `npm install`
from the repository root, when `package.json` lives in `src/`, silently creates
a second manifest and `node_modules` at the root. Nothing errors; the dependency
is simply invisible to the app. Happened four times. `npm` walks *up* for a
manifest, never down.

## Express

**Query parameters are on `req.query`, not `req.body`.** Parsing `req.body` on
a GET produced `expected object, received undefined` — the empty `path: []` in
a Zod error means "the whole input was wrong", not one field. On a GET with no
body, `express.json()` leaves `req.body` undefined.

**Middleware order is registration order.** `app.use(securityMiddleware())`
placed after `app.get("/")` never runs for `/`. Routes declared above a
middleware do not reach it. Security middleware belongs above every route.

**Registering the same protection twice doubles its cost.** An inline Arcjet
middleware plus `securityMiddleware()` meant two `protect()` calls per request:
the rate limit was consumed twice, so a 50-request window allowed 25. Measured,
not theorised.

**`app.listen()` creates a *new* HTTP server.** With a WebSocket server attached
to `http.createServer(app)`, calling `app.listen()` leaves that server unused, so
upgrade requests never arrive. HTTP works perfectly and only WebSockets fail —
which makes it hard to spot. Use `server.listen()`.

**Express 5 forwards async errors automatically**, unlike Express 4. A throwing
`async` handler reaches error middleware without a wrapper.

## WebSockets

**`return` inside a broadcast loop exits the whole broadcast.** `for (const c of
clients) { if (c.readyState !== OPEN) return; ... }` stops at the first closed
client, so nobody after it receives the message. Wanted `continue`. In the
original inverted form it sent to nobody at all.

**Connections die silently.** A sleeping laptop or NAT timeout leaves a socket
in `wss.clients` with `readyState === OPEN` forever. Only a ping/pong heartbeat
detects it. `terminate()`, not `close()` — a half-open socket never completes a
closing handshake.

**`detectBot` cannot evaluate a WebSocket upgrade from a non-browser client.**
Arcjet logs "DetectBot requires `user-agent` header to be set" because the `ws`
client sends none. Browsers do send one, so the rule works in production.

## Databases and null

**`new Date(null)` is the Unix epoch, not an invalid date.** So a
`Number.isNaN(date.getTime())` guard does not catch it, and `now >= end` was
true for every match whose `end_time` was NULL — marking matches finished
before they kicked off. Handle absence *before* parsing, never rely on a parse
guard to catch it.

**`?? null` into a NOT NULL column fails.** Sending an explicit NULL where the
column has `NOT NULL DEFAULT 0` raises Postgres `23502`. Omitting the key
entirely lets the database apply its default — one source of truth instead of
two.

**Drizzle wraps driver errors.** A Postgres constraint violation arrives as a
`DrizzleQueryError` whose `code` is `undefined`; the SQLSTATE is on
`error.cause.code`. Checking `error.code` silently fell through to a blanket
500, so a duplicate sequence and a missing match both looked like server
faults instead of 409 and 404. When branching on an error, print its actual
shape first rather than assuming the driver's.

**Constraint violations are usually client errors, not server errors.**
`23503` foreign_key_violation means the referenced row does not exist — 404.
`23505` unique_violation means the caller asked for a slot already taken —
409. Returning 500 for either tells the client to retry something that will
never succeed.

**Sequences never reuse numbers.** `nextval()` is consumed before constraints
are checked and does not roll back, so failed inserts and rolled-back
transactions leave permanent gaps. IDs are identifiers, not counters.

## JavaScript

**A bare `catch { }` binds nothing.** `catch { console.error("failed", error) }`
raises `ReferenceError: error is not defined`, turning a handled failure into an
unhandled one. Write `catch (error)`.

**`z.coerce.number()` is `Number()`, which is far more permissive than it
looks.** `Number(null)` is `0`, `Number(true)` is `1`, `Number([])` is `0`,
`Number('')` is `0`. So a coerced schema accepted `"minute": null` and silently
stored `0` — an event at kickoff, not an unknown minute. Coercion earns its
place for query and path params, where every value genuinely arrives as a
string. In a JSON body the numbers are already numbers, so coercion buys
nothing and loses the distinction between absent and zero.

**Validate against the column's range, not just its type.** Postgres `integer`
is 4 bytes, but `z.number().int()` has no upper bound, so oversized values
passed validation and failed at insert with `22003` — a 500 for what was
plainly a bad request. The schema should refuse anything the column cannot
hold.

**`JSON.stringify(new Error(...))` returns `{}`.** `message` and `stack` are not
enumerable, so error details vanish. Use `error.message`.

**Unreachable branches are a smell.** `if (!key) throw ...` followed by
`key ? build() : null` makes the `null` branch dead — the two lines encode
contradictory intentions. Pick one: fail hard, or treat absence as "disabled".

## Configuration

**A variable that is read must be the variable that is set.** The code read
`ARCJET_MODE` while `.env` defined only `ARCJET_ENV`, so the mode was always
`LIVE` and the `DRY_RUN` escape hatch was unreachable. Similar names are not the
same name.

**Config read at import time needs dotenv loaded first.** A module that reads
`process.env` at the top level sees nothing unless `dotenv/config` has already
run.

**Allow-lists deny by default.** Arcjet's `detectBot` with
`allow: ['CATEGORY:SEARCH_ENGINE']` blocks curl and Postman — including with a
browser User-Agent, since it fingerprints more than the header. Every request
returned 403 and the API could not be exercised by hand.

## Design lessons

**A cross-file invariant is invisible at the call site.** `getMatchStatus` could
return null into a NOT NULL column; it was safe only because Zod, in another
file, rejected bad dates first. Nothing in the route said so. Relaxing the
validation would have reintroduced the bug silently. Guard where the assumption
is used, not only where it happens to hold.

**Notify after you respond.** A broadcast inside the insert's `try` meant a
notification failure returned 500 for a row that was already committed.

**Fail open or fail closed is a decision, not a default.** HTTP fails open here
(an outage should not take the API down); WebSockets fail closed (an unvetted
socket persists for hours). The asymmetry is deliberate — what matters is
choosing rather than inheriting.

**Rate limits are eventually consistent.** Ten WebSocket upgrades opened
simultaneously were all allowed, while opened sequentially the 6th onward were
refused. A sliding window is evaluated before it increments, so it throttles
sustained load, not one instantaneous burst. It also makes tests flaky when run
back-to-back.

## Git and tooling

**An empty `.git` *file* is not a repository.** `git init` failed with
`fatal: invalid gitfile format` until the zero-byte file was removed.

**A `.gitignore` only covers its own directory downward.** With the only
ignore file in `src/`, the repository root was uncovered and `git add -A` was
about to commit the whole of root `node_modules/`.

**Branches are labels; commits outlive them.** Work drifted onto one
long-lived branch while `main` sat four commits behind holding a stale tree —
leaving no current baseline to branch from.
