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

**Everything that must survive an `await` has to be registered before it.** The
connection handler in `ws/server.js` is `async` and awaits a network call to
Arcjet (47-226ms). `socket.on('message')` was correctly hoisted above that await
- there was even a comment explaining why - but `'error'` and `'close'` were left
below it, and those are the two that actually bite. A WebSocket that emits
`'error'` with no listener is an uncaught exception, so for the length of that
window any client could kill the server with one oversized frame. `'close'` fires
exactly once, so a socket that went away mid-check had its only close event land
on nothing. When one listener is hoisted for a reason, that reason almost always
applies to its siblings.

**A missing `'error'` listener is a crash, not a missed log line.** Node's
EventEmitter treats `'error'` specially: emitting it with no listener throws. Any
long-lived object worth attaching handlers to - a socket, a pg Pool - needs an
`'error'` listener for that reason alone, even when there is nothing useful to do
in it. `db/db.js` had no `pool.on('error')`, and pg emits that on the pool when an
*idle* client dies. A routine Neon connection drop would have taken the process
with it.

**A bug that only exists inside an `await` may be invisible to your tests.**
Without an `ARCJET_KEY` the check is skipped entirely, so the async handler runs
start to finish synchronously and the window does not exist - none of the three
bugs above could be reproduced by the test suite as configured. Making the
dependency injectable (`attachWebSocketServer(server, { arcjet })`) was what made
them testable, and it is better design anyway: the hidden module-level import
became an explicit parameter.

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

**Iterating a `Map` yields `[key, value]` pairs, not keys.** `for (const k of
map)` gives you an array like `[5, Set]`, so `map.get(k)` is `undefined` and
every lookup silently misses. Cleanup on disconnect therefore removed nothing
and dead sockets accumulated in the subscriber sets. Use `map.keys()` — or
better, iterate the small per-socket set of things it joined rather than
scanning everything.

**Order matters when removing from a collection.** Checking `size === 0`
*before* deleting the member means the emptiness check always runs one call
behind, so the empty container is never cleaned up. Remove first, then test.

**State a client can create for free has to be bounded.** A `subscribe`
message costs the client nothing and costs the server a map entry. Without a
cap on how many and a check on what, one socket can grow server memory
indefinitely. Validate the id against the same range the column allows, and
cap the count per connection.

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

**Fixing a bug in one file does not fix the pattern.** The `z.coerce` problem
was found and fixed in the commentary schema, but the identical bug sat
untouched in the match schema for another two days — `"homeScore": null` still
became `0`, `true` still became `1`. Nothing pointed from one to the other. When
a bug turns out to be a *class* of bug rather than a one-off, grep for the
pattern across the codebase before closing it out.

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

**A disable flag should fail safe on a typo, and the two ways to be "off" should
be distinguishable.** Arcjet protection could only be turned off by blanking
`ARCJET_KEY`, which looks identical in the logs to a production deploy that
forgot to configure its key. Now `ARCJET_ENABLED=false` says off-on-purpose and
a missing key still says misconfigured. The comparison is `=== 'false'`, not
truthiness, so `flase` or `0` leaves protection **on** — verified by booting
with `ARCJET_ENABLED=flase` and seeing Arcjet still initialise. A flag that
controls a safety feature should require the exact word to disarm it.

**The apminsight agent gets that backwards, and reads its own flag two different
ways.** In `apminsight/index.js`, the import-time `AgentAPI()` at line 23
requires `APMINSIGHT_AGENT_DISABLE.toLowerCase() == "true"`, but
`AgentAPI.config()` at line 41 only tests `if (process.env.APMINSIGHT_AGENT_DISABLE)`.
`"false"` is a truthy string, so `APMINSIGHT_AGENT_DISABLE=false` skips
`config()` while still running the import-time init — a half-started agent, and
the opposite of what the name says. Set it to `true` or leave it unset, never
`false`. Evidence that both paths run: with the flag correctly set to `true`,
`[APM] Apminsight agent is disabled.` prints **twice** on boot, once per code
path.

**`DRY_RUN` removes the enforcement, not the cost.** Arcjet's `DRY_RUN` still
makes the network call — it evaluates rules and logs what it would have done.
So it is the wrong tool for getting a rate limiter out of the way during a load
test (the 47–226ms round trip stays, and it still bills), and the right tool for
measuring what that layer costs you. "Disabled" and "not enforcing" are
different states.

## Measuring

**Measure the thing before optimising it, because the bottleneck is usually not
where the plan assumed.** The Phase 1 baseline was taken to justify Redis
pub/sub. At 500 concurrent WebSocket connections and 10 publishes/s, end-to-end
POST-to-frame latency was p50 38ms — of which **~33ms was the Neon INSERT and
5.2ms was the fan-out loop** (1.3ms at 50 connections, 2.8ms at 200). Redis
cannot make an INSERT faster, so it will not move the headline number. That does
not make Phase 2 wrong; it makes it a *correctness* change — with two instances,
a POST landing on instance A must reach subscribers on instance B, and
`matchSubscribers` is per-process. Knowing which of those it is beforehand is
the difference between a claim and a measurement.

**Split a latency number into the parts different fixes can move.** Reporting
only end-to-end would have hidden the fan-out cost behind a constant database
write. The route responds *before* it broadcasts, so recording the HTTP request
on its own (`post_duration`) and subtracting gives the fan-out share. A single
aggregate number is not actionable; a decomposed one tells you which change
would help.

**Percentiles need to be tagged by load level or they describe nothing.** A p99
across a run that ramps 50 → 200 → 500 blends three regimes. Tagged per plateau,
the tail was visibly the part that degraded — p99 67ms → 155ms → 220ms while p50
barely moved from 33ms to 38ms. The median hid the only thing that was changing.

**A rate limiter in front of the system is part of the measurement, so price it
separately.** Same load with Arcjet back in the path (DRY_RUN — evaluating, not
blocking) moved POST p50 from ~33ms to ~93ms: a flat **~60ms per request**,
independent of connection count, roughly tripling the latency. Server CPU went
from 13.7s to 116.6s for the same work. Worth knowing which share of a latency
budget belongs to a third party rather than to your own code.


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

---

# Debugging stories

Longer write-ups of the bugs that took real diagnosis. Kept in symptom →
investigation → root cause → fix → evidence order, because that is the order
someone will ask about them.

## Every match was marked "finished" before kickoff

**Symptom.** `getMatchStatus` returned `finished` for matches that had not
started. Only for some matches, which made it look intermittent.

**Investigation.** The function already guarded against unparseable dates with
`Number.isNaN(end.getTime())`, so an invalid `endTime` seemed covered. Testing
the function directly with the two nullish values separated the cases:
`endTime: undefined` returned `null`, but `endTime: null` returned `finished`.

**Root cause.** `new Date(null)` is not an invalid date — it is the Unix epoch,
`1970-01-01`. The NaN guard therefore passed, and the `now >= end` comparison
was true for every match. Since `end_time` is nullable and Drizzle returns
`null` for a match that has not concluded, every unfinished match qualified.
Worse, `syncMatchStatus` would then persist `finished` to the database.

**Fix.** Handle the absent end time *before* parsing it, rather than relying on
a parse guard to catch it. Return `scheduled` before kickoff, `live` after.

**Evidence.** Wrote 18 tests, then re-ran them against the old implementation:
5 failed. A test suite that cannot fail against the bug it describes has not
proven anything.

## HTTP worked perfectly and WebSockets silently did not

**Symptom.** Every REST route returned 200. WebSocket clients could not connect
at all — no error, no log, just a connection that never opened.

**Investigation.** The WebSocket server was constructed and attached without
throwing, so the failure was not in `ws`. Working backwards from what the two
protocols share: both are supposed to run on the same HTTP server.

**Root cause.** `index.js` created `const server = http.createServer(app)`,
attached the WebSocket server to `server`, and then called `app.listen()`.
`app.listen()` quietly creates a *second* HTTP server. The one holding the
WebSocket upgrade handler was never listening, so upgrade requests never
reached it.

**Fix.** `server.listen()`.

**Evidence.** After the change the same client received `{"type":"welcome"}` on
`ws://localhost:8000/ws` while `GET /` still returned 200 — both on one port.

## The rate limit was silently half what it claimed

**Symptom.** None visible. Requests were rejected "a bit early", easy to
dismiss as the limiter being approximate.

**Investigation.** Rather than read the code, measured it: 60 rapid requests to
two different routes. `/` allowed 49; `/matches` allowed 25. A limiter does not
apply two different limits to one window, so the difference had to be
structural — and it lined up exactly with where each route sat in the
middleware chain.

**Root cause.** Arcjet was registered twice — an inline middleware plus a
refactored `securityMiddleware()`. Routes registered after both called
`protect()` twice per request, consuming the quota twice and doubling the calls
billed. Routes registered between them called it once.

**Fix.** Delete the inline copy and register the survivor above every route,
since Express matches in registration order and `GET /` had been declared
before it.

**Evidence.** `/matches` went from 25 back to the full window; `/` went from 60
unlimited to 50 allowed and 10 denied, confirming it was covered rather than
skipped.

## Constraint violations all looked like server errors

**Symptom.** `POST /matches/:id/commentary` returned 500 both for a duplicate
sequence and for a nonexistent match, despite explicit handling for Postgres
`23505` and `23503`.

**Investigation.** The handling looked correct, so the assumption underneath it
was the suspect: that `error.code` holds the SQLSTATE. Printed the error's
actual shape instead of guessing — constructor, `code`, and `cause`.

**Root cause.** Drizzle wraps driver errors in a `DrizzleQueryError` whose own
`code` is `undefined`. The Postgres error is on `error.cause`.

**Fix.** Read `error?.cause?.code ?? error?.code`, keeping the fallback in case
an unwrapped error ever arrives.

**Evidence.** Duplicate sequence returns 409 and a missing match returns 404 —
both client errors. A 500 tells the caller to retry something that can never
succeed.

## "minute": null was stored as minute 0

**Symptom.** None at request time — the API returned 201. The row simply held
`0` where the client had sent `null`.

**Investigation.** Probed the schema with the values a client might realistically
send for "unknown": `null`, `true`, `[]`, `""`. All four were accepted, and all
four produced `0` or `1`.

**Root cause.** `z.coerce.number()` is `Number()` underneath, and `Number(null)`
is `0`. Coercion was inherited from the query-parameter schemas, where it is
correct because every value genuinely arrives as a string. In a JSON body the
numbers are already numbers.

**Fix.** Plain `z.number()` for body fields; coercion kept for query and path
params. Also bounded every integer to `2147483647`, since Postgres `integer` is
4 bytes and oversized values were passing validation only to fail at insert
with `22003` — another 500 for what was plainly a bad request.

**Evidence.** `null` now returns 400 naming the field, and the three inputs that
previously produced 500s return 400 instead.

## A 500 for a write that had already succeeded

**Symptom.** `POST /matches/:id/commentary` returned 500. The row was in the
database. Retrying the identical request returned 409 "already exists".

**Investigation.** Reproduced by mounting the real router with a broadcaster
that throws. The client was told 500, `SELECT` showed the row present, and the
retry hit the unique `(match_id, sequence)` constraint.

**Root cause.** The broadcast sat inside the same `try` as the insert. A `try`
answers one question — did anything in here throw — and cannot say *which*
thing. So a failure in the notification, which matters only to other viewers,
was reported as a failure of the write the client asked for. Worse, the
broadcast loops over subscribers, so it can throw partway: row committed, some
subscribers notified, author told it failed.

**Fix.** Respond first, then broadcast in its own `try`. Once `res.json()` has
gone out the answer is settled and no later error can rewrite it. The
notification failure gets logged instead of escalated.

**Evidence.** Same broken broadcaster now returns 201 with the row in the body.
The 500 also invited a retry that could only ever hit a 409 — a status code
telling the client to retry something guaranteed to fail is worse than no
handling at all.

## Messages sent on connect vanished

**Symptom.** A client that connected and immediately sent `{type:'subscribe'}`
never got an acknowledgement, and never received commentary. Sending the same
message a moment later worked. Intermittent, which made it look like a race in
the test.

**Investigation.** Other traffic proved the socket was healthy — a
`matchCreated` broadcast reached it fine. So the connection was up but that
one message was gone. Timed the Arcjet call the connection handler awaits:
**47–226ms**. Then reproduced it in isolation with a `setTimeout` standing in
for the check: of two messages, only the later one arrived.

**Root cause.** `wss.on('connection', async ...)` awaited the Arcjet decision
before registering `socket.on('message')`. Node drops a `message` event that
has no listener, so everything sent during that window was discarded with no
error on either side.

**Fix.** Register the listener immediately, queue what arrives (bounded, so a
connection about to be refused cannot buffer indefinitely), and drain it once
the decision lands.

**Evidence.** Subscribing immediately on open now returns `subscribed`, and a
commentary POST reaches that subscriber and no one else. The general shape is
worth remembering: **an `async` event handler leaves a window in which the
listeners it registers do not exist yet.**

## A load test that reported 253,225 iterations for 3,300 requests

**Symptom.** The Arcjet comparison run, configured for 4m40s, took 8m04s of wall
clock. k6's own progress line disagreed with itself: `running (7m33.5s)` while
the scenario read `4m09.4s/4m40.0s`. Both runs reported implausible iteration
counts — 182,349 and 253,225 — against roughly 3,300 actual requests (2,800
publishes plus 500 held sockets).

**Investigation.** The iteration count was the thread worth pulling: an
iteration count two orders of magnitude too high means iterations that do
nothing. `iteration_duration` confirmed it — median **16.25µs**, which is not a
network round trip, it is a function returning immediately.

That pointed at a guard added earlier in the same session. Subscriber VUs hold
one socket for the rest of the run, so a VU recycled near the end would open a
socket it had to close immediately; the guard skipped that with an early
`return`. But `ramping-vus` starts a new iteration the instant one ends, so
"return immediately" is a hot loop, not a no-op. It fires when
`remainingMs < 5000`, and 500 VUs spun for the final seconds.

**Why it mattered, and why it did not.** The guard window (test time > 275s)
starts *after* the last plateau ends (270s), so the recorded p50/p95/p99 for
every plateau are unaffected in both runs — worth establishing before deciding
whether to re-run. What it did do was burn CPU competing with the server, and in
the Arcjet run it ran for 209 seconds instead of 5, because a POST hung on a
Neon `read ETIMEDOUT` (`http_req_duration` max **3m42s**, 4 occurrences) and k6
waits for in-flight iterations before finishing.

**Fix, and the second bug inside the fix.** Replacing `return` with
`sleep(remainingMs / 1000)` did not work: 14,963 iterations in the last 0.3s.
Once the run is past its nominal end `remainingMs` is *negative*, and the
`Math.max(remainingMs, 0)` clamp turned that into `sleep(0)` — which returns
immediately and spins exactly as before. A guard that can be handed a negative
duration needs a non-zero floor, not a zero one:
`sleep(Math.max(remainingMs / 1000, 1))`.

**Evidence.** Same smoke configuration (5 connections, 2 publishes/s, 18s):
14,963 iterations before, **40** after — 36 publishes plus 5 held sockets, which
is exactly right. `ws_connected` also dropped from 7 to 5, matching the VU count
one-for-one.

## One oversized frame could kill the server, and only in production

**Symptom.** None, which is the point. Nothing had crashed. This came out of
reading `ws/server.js` rather than debugging a failure, and the reasoning is the
part worth keeping.

**Investigation.** The connection handler carries a comment explaining that
`socket.on('message')` is registered *before* the awaited Arcjet check, because
Node drops a `'message'` event that has no listener. That is correct. But
`'error'` and `'close'` were registered after it. If the reason applies to
`'message'`, why not to the others?

Reading `ws` settled it. `node_modules/ws/lib/websocket.js:1216` (`receiverOnError`)
calls `websocket.emit('error', err)` for any protocol violation - a frame over
`maxPayload`, invalid UTF-8, a bad reserved bit. Node throws on an `'error'`
event with no listener. So for the 47-226ms of the Arcjet round trip, any client
could crash the process with one frame, unauthenticated.

A near miss worth recording: the first guess was that the *heartbeat* would crash
on a closing socket, because it calls `socket.ping()` on everything in
`wss.clients` without checking `readyState`. Reading the source ruled it out -
`ping()` with no callback routes to `sendAfterClose`, which only constructs an
error `if (cb)`. Silent no-op. The suspicion was wrong; checking it cost two
minutes and stopped a wrong claim.

**Root cause.** Handler registration ordering around an `await`. One cause, two
bugs: the crash, and a subscription leak where a socket that disconnected
mid-check had its only `'close'` event land on no listener, then got added to
`matchSubscribers` when the queue drained - a CLOSED socket nothing would ever
remove.

**Why it was production-only.** With `wsArcjet` null (no key) there is no await
at all, so the handler runs synchronously and the window does not exist. It could
only ever fire with Arcjet enabled - which is the deployed configuration, and the
one least likely to be exercised locally.

**Fix.** Hoist `'error'` and `'close'` above the await, alongside `'message'`.
Hoisting `'close'` is necessary but *not sufficient* for the leak: the close has
already fired by the time the queue drains, so the drain also needs
`if (socket.readyState !== WebSocket.OPEN) return;`. Add `pool.on('error')` in
`db/db.js` for the same class of bug one layer down.

**Evidence.** Both were reproduced standalone before fixing - the crash as
`UNCAUGHT EXCEPTION -> Max payload size exceeded`, the leak as `retained: 1,
readyState: 3` with zero live clients. The five regression tests in
`ws/server.test.js` now fail 5/5 against the pre-fix ordering and pass 5/5 with
it, which is the check that matters: a regression test that passes both ways
tests nothing.
