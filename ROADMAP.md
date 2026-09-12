# Roadmap

Where this project goes next, in the order I'd actually do it.

**Reordered 2026-09-12.** The previous version had two tracks — "make it scale"
(Redis, backpressure, 5,000-connection tests) listed first, "make it real"
(deploy, auth, live data) second — and it argued in its own last section that
the product track should probably come first. This version commits to that.

The reason is simple: the app cannot yet update a score or move a match from
`scheduled` to `live`, and no stage covered that. Redis pub/sub is a solution to
a multi-instance problem for a product that does not exist yet. So the order is
now: **finish the product, deploy it, feed it real data, then measure and scale
it against real traffic** — which the old version already admitted would make
the measurements more credible.

**Everything already measured stays valid.** Phase 1's numbers are about what the
system does once an event exists. Whether that event came from a person typing it
or a poller pulling it from an external API changes nothing downstream — same
Zod validation, same insert, same broadcast, same fan-out. See
`load-tests/PHASE1-FINDINGS.md`.

The [old → new stage mapping](#what-changed-on-2026-09-12) is at the bottom.

---

## The plan in one screen

Each stage is one line; the detailed sections that follow say how and why.

**Block 1 — finish the product.** Turns it into something that runs, unattended,
on live data.

| Stage | In one line | What the story is |
|---|---|---|
| 0 ✅ | Fix the two remotely-triggerable crashes and the subscription leak around the awaited Arcjet check. | Done — 5 regression tests |
| 1 ✅ | Cheap cleanup: stop leaking DB internals, purge load-test rows, `.gitignore`. | Mostly done |
| 2 | Route tests + CI. Only the WS server and the status helper are tested; every HTTP check so far has been manual `curl`. | Protects everything after it |
| 3 | **Complete the domain model.** Scores cannot be updated and a match created as `scheduled` stays `scheduled` forever. Wire up `updateScoreSchema` and `syncMatchStatus`, both of which exist and are called by nothing. | The core of a "sports dashboard" |
| 4 | Graceful shutdown. Every restart drops every live connection and abandons the pg pool. | Prerequisite for deploying |
| 5 | API keys on write endpoints — today anyone can `POST` commentary to any match. Decide multi-tenancy here, once, while it's cheap. | Auth, and a deliberate schema decision |
| 6 | Deploy it. | A URL someone can hit |
| 7 | Stop typing matches in by hand — poll OpenLigaDB every 30s. Re-polling must not create duplicates: a unique index on the upstream `goalID` makes the database refuse repeats. | Idempotent ingestion |
| 8 | Write the latency claim honestly: ~100ms event→subscriber *and* 30–60s upstream refresh are both true; don't blur them into "sub-second live scores". | Knowing which part you control |

**Block 2 — measure and scale it.** Produces the before/after story with numbers,
now against real traffic rather than synthetic.

| Stage | In one line | What the story is |
|---|---|---|
| 9 | Find out why writes got 3× slower when load only doubled — is the `pg` pool too small, or is Neon the limit? Change one variable at a time. | "I had a lead, I isolated it" |
| 10 | Add `/stats` so connection counts are *read*, not derived from OS socket counts. | Needed to prove stage 13 |
| 11 | Push to 2,000–5,000 connections and find where it actually breaks. At 500 the server used 11% of one core, so the ceiling is unknown. | "Here is the real ceiling and what broke first" |
| 12 | One slow client currently slows broadcasts for everyone — pick a backpressure policy. And let a client that drops mid-match ask for everything since sequence N. | Backpressure + replay |
| 13 | Two server instances can't see each other's subscribers because `matchSubscribers` is an in-memory `Map`. Redis pub/sub fixes that. Re-run the identical load test after. | "Horizontal scaling, and the median didn't move — which is correct" |

**Block 3 — extras.** Worth doing, not load-bearing.

| Stage | In one line | What the story is |
|---|---|---|
| 14 | Push events out via webhooks (Discord first). Discord allows ~5 msgs / 2s and the system emits 20 events/s, so events must be **batched**, not just retried. | Rate-limited downstream, coalescing |
| 15 | Aggregate queries over real data — top scorers, match summaries. | Finally uses the relational API |

**The live-data source is already chosen: [OpenLigaDB](https://api.openligadb.de).**
Stage 7 records why the two obvious candidates failed (football-data.org has no
events on its free tier; API-Football caps at 100 requests/day). OpenLigaDB has
no key and no signup, returns real goal events with stable `goalID`s, and was
re-checked live on 2026-09-12 — it served the current Bundesliga matchday with
goals attached. Trade-offs: German football only, goals but not cards or subs,
and it's crowdsourced so freshness is best-effort. **No code calls it yet.**

**The cheapest high-credibility subset** is still stages 2, 4, 6 (tests, shutdown,
deploy) then 13 (Redis). But stage 3 is what makes it an app rather than a demo,
and it is small.

---

## Stage 0 — Make it safe to run at all — DONE

*Fixed 2026-09-09. Five regression tests in `ws/server.test.js` fail 5/5 against
the pre-fix ordering and pass 5/5 with it. `stats()` on the return of
`attachWebSocketServer` came out of this (a leaked subscription is invisible from
outside, since a CLOSED socket is already gone from `wss.clients`) and is the
groundwork for Stage 10.*

**Blocked everything else, including any bigger load test and any deployment.**
Two of these are remotely triggerable crashes; a 5,000-connection test is exactly
the workload that finds them.

| # | Change | Where |
|---|---|---|
| 0.1 | Move `socket.on('error')` above the `await wsArcjet.protect(req)` | `ws/server.js:166` |
| 0.2 | Move `socket.on('close')` above the same `await` | `ws/server.js:170` |
| 0.3 | Add `pool.on('error', ...)` | `db/db.js:9` |

**Why each is real, not theoretical:**

- **0.1** — during the 47–226ms Arcjet check the socket has no `'error'` listener.
  `ws` emits `'error'` on the WebSocket for any protocol violation, including a
  frame over the `maxPayload: 1024 * 1024` set at `server.js:110`. An unhandled
  `'error'` is an uncaught exception. Reproduced: oversized frame inside the
  window → `UNCAUGHT EXCEPTION -> Max payload size exceeded`. Note this **only
  fires when Arcjet is enabled** — with `wsArcjet` null there is no `await`, so
  the handler registers synchronously and the window does not exist. It is a
  production-only crash, and any client can trigger it with no auth.
- **0.2** — same window. A client that sends `subscribe` then disconnects mid-check
  has its `'close'` fire with no listener; the queue then drains and adds a
  now-CLOSED socket to `matchSubscribers`, and the close handler is attached to an
  event that already fired. Reproduced: `live clients: 0`, `retained: 1`,
  `readyState: 3`. Slow memory leak.
- **0.3** — `pg` emits `'error'` on the Pool when an *idle* client fails
  (`pg-pool/index.js:62`) and nothing listens. Not hypothetical: the Arcjet load
  run logged 4 × `read ETIMEDOUT` against Neon. Those were caught because they hit
  mid-query; the same failure on an idle connection takes the process down.

**Done:** `npm test` is 23 passing (18 + 5 new). Hoisting `'close'` turned out to
be necessary but not sufficient for the leak — the close has already fired by the
time the queue drains, so the drain also needed
`if (socket.readyState !== WebSocket.OPEN) return;`.

---

## Stage 1 — Cheap cleanup — MOSTLY DONE

*2026-09-09.*

- **1.1 done.** `routes/matches.js` no longer leaks database internals. All four
  sites fixed: the two 400s now return `zodDetails(...)`, and the two 500s log
  server-side and return a generic message. The helper was extracted to
  `validation/errors.js` and both routers import it, so the two cannot drift into
  reporting validation failures in different shapes. Verified against a live
  server — a bad query now returns
  `{"field":"limit","message":"limit must be a number"}` instead of an escaped blob.
- **1.2 outstanding — yours.** Rotate the Arcjet key; it was printed in a terminal
  transcript. Only doable from the Arcjet dashboard.
- **1.3 done.** Deleted 11 `sport = 'loadtest'` matches, which cascaded to 10,701
  commentary rows. The two real `football` matches (ids 9 and 10) and their single
  commentary row were verified untouched beforehand and remain.
- **1.4 done.** `.idea/` and `.vscode/` added to the root `.gitignore`.
- **1.5 outstanding.** The stray root `package.json` / `package-lock.json` /
  `node_modules` are untracked, so they live in the working copy rather than in a
  commit. Nothing imports them.

Toggles were already done (`ARCJET_ENABLED`, `APMINSIGHT_AGENT_DISABLE`, commit `1ea98bb`).

---

## Stage 2 — Route tests and CI

*Was a "stage 1 leftover" with no stage of its own. Promoted, because stage 3
changes the routes and the broadcast contract, and there is currently nothing
that would catch a regression there.*

Only `utils/match-status.js` and `ws/server.js` have tests. Every HTTP check so
far — the 400 shapes, the 201, the 23505 handling — was a manual `curl` against
a live server, which means it was verified once and never again.

- `node:test` plus `fetch` against `server.listen(0)` (port 0 = any free port).
  No new dependencies.
- Cover per route: the 400 shape from `zodDetails`, the happy path, and the 500
  path with the DB call stubbed to throw. The 500 test is the one that proves
  the stage 1 fix — that the response body is generic and the detail went to
  the log.
- The commentary `23505` → 409 mapping is worth a test of its own; it is the
  behaviour stage 7's poller depends on.
- Then a GitHub Actions workflow that runs `cd src && npm test` on push. The
  database-backed tests need either a `DATABASE_URL` secret pointing at a Neon
  branch or the DB layer injected so routes can be tested without one. The
  second is more work and more honest; decide when you get there.

---

## Stage 3 — Complete the domain model

*New on 2026-09-12. Not in the previous roadmap at all. This is the gap the
reorder was about: two of the three things a sports dashboard is for — the
score and whether the match is on — cannot currently change after creation.*

**What is broken, concretely:**

- `POST /matches` calls `getMatchStatus(start, end)` **once, at insert time**,
  and stores the result. A match created at 14:00 with a 15:00 kickoff is stored
  as `scheduled` and is still `scheduled` at 15:30, at 17:00, and next week.
  `syncMatchStatus` exists to fix exactly this and is called only by its own tests.
- `homeScore` / `awayScore` can be set on create and never again. `updateScoreSchema`
  exists in `validation/matches.js` and is imported nowhere.
- `endTime` is documented as "null until the match actually ends" — but nothing
  ever sets it, so a match with no `endTime` becomes `live` at kickoff and is
  `live` forever.

**3.1 — Score updates.** `PATCH /matches/:id/score` with `updateScoreSchema`,
returning the updated row, 404 when the id does not exist. Then broadcast.

The broadcast question is the same one commentary already answered, with a
different answer. Commentary goes to subscribers of that match only, because it
is high-frequency and only interesting to viewers of that match. A score change
is low-frequency (a handful per match) and interesting to anyone looking at the
list of matches, not just the people watching one. So: **`scoreUpdated` to every
client, like `matchCreated`**, not just to subscribers. The trade-off is that a
client watching one match also hears about every other match's goals; at a few
events per match that cost is nothing, and it means a dashboard can keep its
match list current without subscribing to everything.

**3.2 — Status transitions.** Three ways to do it; pick one and say why.

| Option | How | Problem |
|---|---|---|
| Derive on read | Never trust the stored column; compute status from the times whenever a row is returned | The `status` column and its `matches_status_start_time_idx` index become dead — `WHERE status = 'live'` would return the wrong rows. And nothing fires a broadcast. |
| Sync on read | Call `syncMatchStatus` per row in `GET /matches` and let it write the correction | A match nobody reads never advances. Write-on-read is a surprise in a GET. |
| **Sweep on a timer** (recommended) | Every N seconds: `UPDATE matches SET status='live' WHERE status='scheduled' AND start_time <= now() RETURNING *`, then the same for `finished` where `end_time <= now()`; broadcast `statusChanged` for each row returned | Runs in-process, so with two instances (stage 13) both sweep. The `UPDATE` is idempotent so the data is fine, but the broadcast would fire twice — note this as a forward dependency and solve it there, not here. |

The sweep uses the existing `(status, start_time)` index — that index was
declared for "what's on now" queries and this is the first one. It is also
set-based: one statement moves every due match, rather than one round trip per
row. `syncMatchStatus` as written is the per-row shape, so it may end up
replaced rather than called; its tests still document the intended transitions
and should keep passing against whatever replaces it.

`LEARNING.md` has a debugging story titled "Every match was marked finished
before kickoff" — read it before touching `getMatchStatus`. The bug was
`new Date(null)` silently becoming the Unix epoch, so every match with no
`endTime` looked finished. The SQL sweep is immune for a reason worth knowing:
`end_time <= now()` with a NULL `end_time` evaluates to NULL, not true, so the
row is simply not matched. That is SQL's three-valued logic doing the null
check JavaScript did not. The 18 test cases from that story are still the ones
to port — the sweep must agree with `getMatchStatus` on every one of them.

**3.3 — Ending a match.** Nothing sets `endTime`. Either `PATCH /matches/:id`
accepts `endTime` (and the sweep picks it up on the next tick), or a dedicated
`POST /matches/:id/finish` sets `end_time = now()` and `status = 'finished'` in
one statement and broadcasts immediately. The second is more explicit and does
not wait for a tick; the first is one endpoint fewer. Recommendation: the
dedicated action — "finish" is a domain event, not a field edit. Stage 7's
poller will call the same code path when OpenLigaDB reports `matchIsFinished`.

**3.4 — Document the WS message contract.** After this stage the socket emits
`welcome`, `matchCreated`, `commentaryCreated`, `scoreUpdated`, `statusChanged`,
`subscribed`, `unsubscribed`, `error`. Write them down in one place with their
payload shapes, because stage 7 and stage 14 both consume them and there is
currently no contract other than reading `ws/server.js`.

**Done when:** a match created with a kickoff two minutes in the future is
`scheduled` in `GET /matches`, becomes `live` within one sweep interval of
kickoff, a `PATCH` to its score is reflected in a `scoreUpdated` frame on a
connected socket, and `finish` moves it to `finished` — all covered by the
stage 2 route tests.

---

## Stage 4 — Graceful shutdown

*Split out of the old "deploy" stage, because it is a prerequisite for it and
worth doing on its own first.*

Every restart currently drops every connection mid-flight and abandons the pg
pool. On SIGTERM/SIGINT: stop accepting new connections (`server.close()`), close
the WebSocket server (`wss.close()`, which sends a close frame to each client so
they know to reconnect rather than time out), then `pool.end()` so in-flight
queries complete. This is what the unused `pool` export at `db/db.js:9` is for.

Also stop the stage 3 sweep timer, and — once stage 14 exists — drain the
webhook queue, or in-flight webhooks are lost.

Bound it: if a clean shutdown takes longer than ~10s, exit anyway. A deploy
that hangs on one stuck client is worse than dropping that client.

Without this, redeploys are visibly broken to anyone connected.

---

## Stage 5 — API-key auth, and the multi-tenancy fork

Right now anyone can `POST` commentary to any match. Combined with Stage 0's
crash, the app should not be internet-facing until this exists.

Minimal: an API key per publisher on the write endpoints only; reads stay open.
This now includes stage 3's `PATCH` score and `finish` endpoints.

**The multi-tenancy fork belongs here, not later.** An API key already implies an
owner, so this is the one moment where adding `org_id` is nearly free. Decide now:

- **Skip it** — fine if this stays single-tenant. Adding it later means a schema
  migration plus scoping every existing query.
- **Add it** — scope `matches` and inherit through `commentary`. The failure mode
  is a **cross-tenant data leak**, and it happens when one query forgets its
  scope. Enforce it at a single choke point (a scoped db helper that every route
  goes through), never per-query. That is the difference between a safe design and
  a leak waiting to be written.

Recommendation: skip unless there is a second real user. But make it a decision,
not a default.

---

## Stage 6 — Deploy it

*Required for "a project I actually use."*

- Stage 4 (graceful shutdown) first, or every redeploy is visibly broken to
  anyone connected.
- Pick a host that supports long-lived WebSockets (Fly.io, Railway, Render).
  Serverless platforms generally do not.
- Neon is already remote, so the DB needs no move — but note that once the app is
  not on the same machine, **all the Phase 1 latency numbers gain a real network
  hop.** They were taken over loopback and are a floor, not a prediction.

---

## Stage 7 — Real data ingestion

### The API choice — this is where the original plan needed correcting

I checked the two APIs named in the original plan, and **neither free tier supports
a live commentary feed**:

| API | Free tier | Verdict |
|---|---|---|
| **football-data.org** | 10 calls/min, 12 competitions, but **scores are delayed and it has no match events at all** — goal scorers and cards are the €29/mo tier, live scores €12/mo | Right budget, wrong data |
| **API-Football** (api-sports.io) | All endpoints including events, but **100 requests/day** | Right data, wrong budget — one 2-hour match polled every 60s is 120 requests, over the daily cap before covering a single match |

**Recommended instead: [OpenLigaDB](https://api.openligadb.de).** No API key, no
signup, ~1000 requests/hour per IP, and it returns real goal events:

```json
{"goalID":130535,"scoreTeam1":1,"scoreTeam2":0,"matchMinute":27,
 "goalGetterName":"M. Olise","isPenalty":false,"isOwnGoal":false}
```

Trade-offs, stated plainly: German football only (Bundesliga, 2. Bundesliga,
DFB-Pokal), goals but not cards or substitutions, and it is **crowdsourced** — so
live freshness depends on volunteers and is not SLA-backed. For a project you run
yourself, no-key and no quota beats broader coverage you cannot afford to poll.

### What the poller writes

This is why stage 3 comes first. Each poll produces three kinds of change, and
each maps onto a code path that stage 3 creates:

- A new `goalID` → insert commentary (existing route logic), **and** update the
  score (stage 3.1) — each goal carries `scoreTeam1` / `scoreTeam2`.
- `matchIsFinished: true` → the stage 3.3 finish action.
- Kickoff passing → nothing to do; the stage 3.2 sweep handles it.

Without stage 3 the poller would have to reimplement all of that inline.

### The design point that matters most: idempotency

A poller re-reads the same match every 30s and must not create duplicate events.
Do **not** solve this in application logic by remembering what you have seen —
solve it in the database, the way the existing schema already solves ordering.

`goalID` is a stable upstream identifier. Add:

```sql
ALTER TABLE commentary ADD COLUMN source_event_id TEXT;
CREATE UNIQUE INDEX commentary_source_event_id_idx
  ON commentary (source_event_id) WHERE source_event_id IS NOT NULL;
```

Then re-polling is idempotent for free: a duplicate insert raises `23505`, which
`routes/commentary.js:97` already handles. The poller treats "conflict" as
"already have it" and moves on. Partial index so hand-entered rows, which have no
upstream id, are unaffected.

This is the same instinct as the `(match_id, sequence)` unique index — let the
database enforce the invariant rather than trusting the caller.

Matches need the same treatment: a `source_match_id` so re-polling the fixture
list does not create the same match twice.

### Upstream failure handling

Same "validate at the boundary, fail gracefully" reasoning already applied to your
own routes, now applied to consuming someone else's:

- Timeout every request (`AbortSignal.timeout`) — a hung upstream must not stall the poller.
- Validate the response with Zod before it reaches the insert. An external API is
  *less* trustworthy than your own clients, not more.
- Back off on failure, and never let the poller crash the process — it runs in the
  same process as the WebSocket server, so an unhandled rejection takes the
  sockets with it.
- Log a skipped poll; do not retry-storm.

### Measuring real freshness

Once ingestion exists, add the upstream event time to the row so you can measure
what actually matters end to end: **upstream event → subscriber receives it**.
The Phase 1 harness measures fan-out using a `postedAt` stamp in `metadata`; the
same trick works here with the real upstream timestamp.

---

## Stage 8 — Correct the latency claim

Once ingestion is live, the writeup must separate two facts that are both true
and easy to conflate:

> Our system delivers an event to every subscriber in **~100ms p50 / 350ms p99**
> once it has the event (measured, 500 concurrent connections, 20 writes/s).
> Our free-tier upstream refreshes every **30–60 seconds**, so real-world
> end-to-end freshness is bounded by the polling interval, not by fan-out.

Blurring those into "sub-second live sports updates" is the one thing here that
would genuinely damage credibility with anyone who reads carefully. Stated as two
separate numbers, it is more impressive, not less — it shows you know which part
you control.

---

## Stage 9 — Chase the write-latency lead

**Do this before any bigger load test.** The write path is the measured
bottleneck, so it will cap whatever a 5,000-connection run can show.

The lead: doubling the write rate from 10/s to 20/s moved the median write from
~33ms to ~100ms — threefold cost for twofold load. `pg` defaults to **10 pool
clients**. The two runs were a day apart, so this is a lead, not a conclusion.

**How to settle it — two axes, one variable at a time:**

1. Fix the write rate at 20/s, vary `Pool({ max })` across 10 / 25 / 50.
   Latency falls as the pool grows → **client-side contention**, and the fix is
   configuration.
2. Fix `max` at 10, vary the write rate across 10 / 20 / 40 per second.
   Latency rises with rate regardless of pool size → **Neon-side**, and the fix is
   batching writes or a paid compute tier.

Both are one-line changes to the existing harness:
`PUBLISH_RATE=40 PLATEAUS=100 ./run-baseline.sh`.

Now that the app is deployed (stage 6), decide whether to run this over loopback
(comparable to Phase 1) or against the deployed instance (realistic, but a
different baseline). Loopback first, so the comparison is clean.

**Done when:** `LEARNING.md` has a debugging story naming which of the two it was,
with the numbers.

---

## Stage 10 — A read-only `/stats` endpoint

Ten lines, and load-bearing twice over. It can be pulled forward to any point
after stage 5 — it is cheap and useful for operating a deployed instance.

Expose `wss.clients.size` and per-match subscriber counts — `stats()` on the
return of `attachWebSocketServer` already computes them. Right now peak
concurrency is *derived* (OS socket count minus the publisher's keep-alive pool,
cross-checked against k6's session count) rather than read. More importantly,
**Stage 13 cannot be proved without it** — with two instances you need per-instance
connection counts to show fan-out actually crossed the gap.

Keep it read-only and behind the stage 5 API key.

---

## Stage 11 — Push to 2,000–5,000 connections

Find the real ceiling. At 500 the server used **11% of one core** with zero loss,
so the limit is well above what has been tested.

**Two things to get right, or the number is meaningless:**

- **Concentrate, don't spread.** Fan-out is sized by subscribers *per match*
  (measured: ~1ms per 100 on a match). To stress the broadcast loop use
  `MATCH_COUNT=1`, not the realistic spread.
- **Watch the load generator's own CPU.** k6 and the server share the same 10
  cores over loopback. If k6 saturates first, the result is a floor on the
  server's capacity, not the server's ceiling — and it must be reported as such.
  Sample `k6`'s process the same way `sample-server.sh` samples the server.

Expect the first thing that breaks to be either the write path (stage 9) or a
slow client degrading the broadcast loop (stage 12). Either is a finding.

---

## Stage 12 — Backpressure and reconnect/replay

**Backpressure.** A slow client currently degrades the broadcast loop for
everyone — `broadcastToMatchSubscribers` calls `client.send()` in a tight loop
with no regard for `bufferedAmount`. Pick one policy and state it: drop frames,
bounded per-socket buffer, or disconnect-and-log. This matters most for a system
whose entire pitch is latency.

**Replay.** Cheap, because the schema already supports it: `sequence` plus the
unique `(match_id, sequence)` index. Buffer the last N events per match and accept
`since=<sequence>` on resubscribe, so a client that drops mid-match catches up
instead of silently missing events.

---

## Stage 13 — Redis pub/sub, then re-measure

**Frame this as a correctness fix, not a performance one.** The measurement is
unambiguous: at 500 connections, 100.5ms of the 102ms median is the Neon INSERT
and 1.5ms is fan-out. Removing fan-out entirely would take 102ms to ~100.5ms.

What it actually fixes: `matchSubscribers` is a per-process `Map`, so with two
instances a write landing on A never reaches subscribers holding sockets on B.
Today that simply does not work.

- Should touch only `ws/server.js`.
- Two Redis clients — a client in subscribe mode cannot publish.
- The stage 3 sweep timer now runs in every instance. The `UPDATE` is idempotent
  so the data is fine, but `statusChanged` would broadcast once per instance.
  Either elect one sweeper (a Redis lock with a TTL) or have the sweep publish
  to Redis and let each instance fan out only what it receives — the second is
  the same path every other broadcast will already be taking.
- Run 2 instances behind a load balancer and re-run the identical k6 script.
- Decide sticky sessions via IP hash (simple, fine at this scale) vs. externalised
  session state (more correct, more work), and be able to explain the fork.

**Success criterion:** a subscriber connected to instance B receives an event
published to instance A, and `/stats` on both instances accounts for every
connection. **Expect the median to be roughly unchanged — that is the correct
outcome.** If it improves noticeably, something else changed and it is worth
finding out what.

---

## Stage 14 — Generic webhook layer (Discord as the first consumer)

Build it as a webhook dispatcher, not a Discord client. Discord is one consumer.

**Three constraints the original list did not account for:**

- **Discord rate-limits webhooks to roughly 5 requests per 2 seconds.** At 20
  commentary events/second you exceed that instantly and start collecting 429s
  with `retry_after`. The layer therefore needs **coalescing** — batch the events
  of the last N seconds into one message — not just retry. This is a design
  requirement, not a tuning detail.
- **Never dispatch inline.** The route already broadcasts *after* responding and
  inside its own try/catch (`routes/commentary.js:75-81`) precisely so a
  notification failure cannot turn a successful write into a 500. An outbound HTTP
  call is far slower and less reliable than an in-process broadcast — it belongs
  on a queue, with the same "already committed, must not fail the write" reasoning.
- **Configure the URL from the environment, not from user input, at least at
  first.** A user-supplied webhook URL is an SSRF vector — the server will happily
  POST to `http://169.254.169.254/` or anything on the local network. If it ever
  becomes user-configurable, block private ranges explicitly.

Also note this interacts with stage 4: in-flight webhooks are lost on restart
unless shutdown drains the queue.

---

## Stage 15 — Stats and history

Aggregate queries over the `commentary` table now that it holds real data: top
scorers, event counts, match summaries. Lower priority, and much more interesting
once stage 7 has populated it with something other than `loadtest` rows.

This is also where `matchesRelations` / `commentaryRelations` finally earn their
keep — they are currently dead code because `db/db.js:13` calls `drizzle(pool)`
without `{ schema }`, so `db.query` is empty and the relational API is unavailable.

---

## What changed on 2026-09-12

The reorder, and the one new stage. Old numbers for anyone who read the
previous version:

| Old | New | Stage |
|---|---|---|
| 0 | 0 | Make it safe to run — done |
| 1 | 1 | Cheap cleanup — mostly done |
| (leftover) | **2** | Route tests + CI — now a stage of its own |
| — | **3** | **Complete the domain model — new.** Scores and status could not change after creation and no stage covered it |
| 7 (part) | 4 | Graceful shutdown — split out as its own prerequisite |
| 8 | 5 | API-key auth |
| 7 (rest) | 6 | Deploy |
| 10 | 7 | Real data ingestion |
| 11 | 8 | Correct the latency claim |
| 2 | 9 | Chase the write-latency lead |
| 3 | 10 | `/stats` |
| 4 | 11 | Push to 2,000–5,000 |
| 5 | 12 | Backpressure + replay |
| 6 | 13 | Redis pub/sub |
| 9 | 14 | Webhooks |
| 12 | 15 | Stats and history |

Why the measurement block moved after the product block: the old version's own
closing note said "real usage produces real load, which is better than synthetic
load to measure against." Stage 13's before/after is more credible run against a
deployed app fed by real data than against a loopback demo that cannot update a
score. Nothing in the measurement block gets harder by waiting; stage 3 gets
harder the longer stage 7 is designed without it.

`load-tests/` still uses the older "Phase 1 / Phase 2" naming from the first
scaling plan. Phase 1 is the baseline that exists; Phase 2 is Redis, now stage 13.

### What changed from the original list (2026-09-10)

Kept for the record — four substantive changes from the version before this one:

1. **The sports API had to change.** Neither football-data.org nor API-Football
   works on its free tier for live events — one has delayed scores and no events,
   the other has a 100/day cap. OpenLigaDB does, with no key. Without this check
   the ingestion stage would have stalled on a paywall.
2. **Deployment and graceful shutdown were missing** and are prerequisites for
   "a project I use myself." Every redeploy currently drops every live connection.
3. **`/stats` moved earlier.** It is ten lines, it replaces a derived number with
   a measured one, and the Redis stage cannot be verified without it.
4. **The webhook layer needs coalescing, not just retries.** Discord's ~5-per-2s
   webhook limit is below the event rate this system produces, so batching is a
   design requirement rather than a later optimisation.

---

## Not doing, and why

- **Chasing broader match coverage on a free tier.** The paid step is €12–29/month
  if it ever matters. Until then, one league with real goal events beats a paywall.
- **Multi-tenancy speculatively.** See stage 5 — it is a real decision, but adding
  `org_id` with no second user is a scoping burden on every query for no benefit.
- **Replacing Arcjet.** It costs a measured flat ~60ms per request and 8.5× the
  server CPU, which is worth knowing, but it is doing a real job. The number is
  recorded so the trade is explicit.
