# Roadmap

Where this project goes next, in the order I'd actually do it.

Two goals are now in play and they pull in different directions:

- **Make it real** — something I run and use, fed by real match data.
- **Make it scale** — the measured before/after story (Redis, backpressure, load).

They are not in conflict, but the ordering matters, and this plan interleaves
them deliberately. See [What changed from the original list](#what-changed-from-the-original-list)
at the bottom for the four places I'd do something different and why.

**Everything already measured stays valid.** Phase 1's numbers are about what the
system does once an event exists. Whether that event came from a person typing it
or a poller pulling it from an external API changes nothing downstream — same
Zod validation, same insert, same broadcast, same fan-out. See
`load-tests/PHASE1-FINDINGS.md`.

---

## Stage 0 — Make it safe to run at all

**Blocks everything else, including any bigger load test and any deployment.**
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

**Done when:** a regression test covers the oversized-frame case and the
subscribe-then-disconnect case, and `npm test` passes.

---

## Stage 1 — Cheap cleanup

Small, unrelated, all quick.

- **1.1** `routes/matches.js` leaks database internals at lines 15, 24, 31, 67
  (`JSON.stringify(error.message)` / `JSON.stringify(parsed.error)`).
  `routes/commentary.js` already does this correctly with its `zodDetails` helper —
  copy the pattern across.
- **1.2** Rotate the Arcjet key (it was printed in a terminal transcript).
- **1.3** `DELETE FROM matches WHERE sport = 'loadtest';` — clears ~10,600 rows from
  the three baseline runs; `commentary.match_id` cascades.
- **1.4** Add `.idea/` to the root `.gitignore`.
- **1.5** Delete the stray root `package.json` / `node_modules` / `package-lock.json`.
  Nothing imports them; they are the "ran npm install from the wrong directory"
  artefact CLAUDE.md warns about.

Toggles are already done (`ARCJET_ENABLED`, `APMINSIGHT_AGENT_DISABLE`, commit `1ea98bb`).

---

## Stage 2 — Chase the write-latency lead

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

**Done when:** `LEARNING.md` has a debugging story naming which of the two it was,
with the numbers.

---

## Stage 3 — A read-only `/stats` endpoint

Ten lines, promoted early because it is load-bearing twice over.

Expose `wss.clients.size` and per-match subscriber counts. Right now peak
concurrency is *derived* (OS socket count minus the publisher's keep-alive pool,
cross-checked against k6's session count) rather than read. More importantly,
**Stage 6 cannot be proved without it** — with two instances you need per-instance
connection counts to show fan-out actually crossed the gap.

Keep it read-only and behind the Stage 8 API key once that exists.

---

## Stage 4 — Push to 2,000–5,000 connections

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

Expect the first thing that breaks to be either the write path (Stage 2) or a
slow client degrading the broadcast loop (Stage 5). Either is a finding.

---

## Stage 5 — Backpressure and reconnect/replay

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

## Stage 6 — Redis pub/sub, then re-measure

**Frame this as a correctness fix, not a performance one.** The measurement is
unambiguous: at 500 connections, 100.5ms of the 102ms median is the Neon INSERT
and 1.5ms is fan-out. Removing fan-out entirely would take 102ms to ~100.5ms.

What it actually fixes: `matchSubscribers` is a per-process `Map`, so with two
instances a write landing on A never reaches subscribers holding sockets on B.
Today that simply does not work.

- Should touch only `ws/server.js`.
- Two Redis clients — a client in subscribe mode cannot publish.
- Run 2 instances behind a load balancer and re-run the identical k6 script.
- Decide sticky sessions via IP hash (simple, fine at this scale) vs. externalised
  session state (more correct, more work), and be able to explain the fork.

**Success criterion:** a subscriber connected to instance B receives an event
published to instance A, and `/stats` on both instances accounts for every
connection. **Expect the median to be roughly unchanged — that is the correct
outcome.** If it improves noticeably, something else changed and it is worth
finding out what.

---

## Stage 7 — Deploy it

*Missing from the original list, and required for "a project I actually use."*

- **Graceful shutdown first** (promoted from the backlog). Every deploy currently
  drops every connection mid-flight and abandons the pg pool. Close the server,
  then `wss.close()`, then `pool.end()` — this is what the unused `pool` export
  at `db/db.js:9` is for. Without it, redeploys are visibly broken to anyone
  connected.
- Pick a host that supports long-lived WebSockets (Fly.io, Railway, Render).
  Serverless platforms generally do not.
- Neon is already remote, so the DB needs no move — but note that once the app is
  not on the same machine, **all the Phase 1 latency numbers gain a real network
  hop.** They were taken over loopback and are a floor, not a prediction.

---

## Stage 8 — API-key auth, and the multi-tenancy fork

Right now anyone can `POST` commentary to any match. Combined with Stage 0's
crash, the app should not be internet-facing until this exists.

Minimal: an API key per publisher on the write endpoints only; reads stay open.

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

## Stage 9 — Generic webhook layer (Discord as the first consumer)

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

Also note this interacts with Stage 7: in-flight webhooks are lost on restart
unless shutdown drains the queue.

---

## Stage 10 — Real data ingestion

### The API choice — this is where the original plan needs correcting

I checked the two APIs named in the plan, and **neither free tier supports a live
commentary feed**:

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

## Stage 11 — Correct the latency claim

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

## Stage 12 — Stats and history

Aggregate queries over the `commentary` table now that it holds real data: top
scorers, event counts, match summaries. Lower priority, and much more interesting
once Stage 10 has populated it with something other than `loadtest` rows.

This is also where `matchesRelations` / `commentaryRelations` finally earn their
keep — they are currently dead code because `db/db.js:13` calls `drizzle(pool)`
without `{ schema }`, so `db.query` is empty and the relational API is unavailable.

---

## What changed from the original list

Four substantive changes, so they are visible rather than buried:

1. **The sports API had to change.** Neither football-data.org nor API-Football
   works on its free tier for live events — one has delayed scores and no events,
   the other has a 100/day cap. OpenLigaDB does, with no key. Without this check
   the ingestion stage would have stalled on a paywall.
2. **Deployment and graceful shutdown were missing** and are prerequisites for
   "a project I use myself." Every redeploy currently drops every live connection.
   Added as Stage 7.
3. **`/stats` moved earlier** (Stage 3). It is ten lines, it replaces a derived
   number with a measured one, and Stage 6 cannot be verified without it.
4. **The webhook layer needs coalescing, not just retries.** Discord's ~5-per-2s
   webhook limit is below the event rate this system produces, so batching is a
   design requirement rather than a later optimisation.

And one thing I would not reorder but would flag: if the priority really is
*using it*, Stages 0, 1, 7, 8, 9, 10 get you a deployed app fed by real data.
Stages 2, 4, 5, 6 are the measurement and scaling story. Both are worth doing —
but real usage produces real load, which is better than synthetic load to measure
against. Doing the product track first would mean Stage 6's re-measurement runs
against something closer to reality.

---

## Not doing, and why

- **Chasing broader match coverage on a free tier.** The paid step is €12–29/month
  if it ever matters. Until then, one league with real goal events beats a paywall.
- **Multi-tenancy speculatively.** See Stage 8 — it is a real decision, but adding
  `org_id` with no second user is a scoping burden on every query for no benefit.
- **Replacing Arcjet.** It costs a measured flat ~60ms per request and 8.5× the
  server CPU, which is worth knowing, but it is doing a real job. The number is
  recorded so the trade is explicit.
