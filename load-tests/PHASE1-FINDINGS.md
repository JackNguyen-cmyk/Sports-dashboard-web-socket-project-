# Phase 1 findings — the "before" number

Two runs, 2026-09-08, identical load: 50 → 200 → 500 concurrent WebSocket
subscribers all watching one match, 10 `POST /matches/:id/commentary` per second
for 4m40s. Single instance, in-process broadcast, Neon Postgres.

Raw output in `results/`. Both runs were taken at commit `1ea98bb`.

| | `20260908T171523Z-baseline` | `20260908T172111Z-arcjet-dryrun` |
|---|---|---|
| Arcjet | out of the path entirely | in the path, `DRY_RUN` (evaluating, not blocking) |
| APM agent | disabled | disabled |

## Headline

**At 500 concurrent connections the system delivered 5,000 messages/second with
zero loss, using 12% of one core.**

- Peak concurrent WebSocket connections held: **501** (OS-measured 520 sockets,
  the 19 difference being the publisher's HTTP keep-alive pool — the two numbers
  agreeing is the evidence that no sockets were dropped)
- Error rate: **0.00%** — 0 of 2,801 POSTs failed
- Delivery: **299,994 of 300,000** expected at the 500 plateau; 641,179 frames
  total across the run
- Peak RSS 327MB, peak CPU **12% of one core**

## Latency, and the part that matters

| Connections | e2e p50 | e2e p95 | e2e p99 | POST p50 | **fan-out** |
|---|---|---|---|---|---|
| 50 | 33ms | 49ms | 67ms | 31.7ms | **1.3ms** |
| 200 | 36ms | 43ms | 155ms | 33.2ms | **2.8ms** |
| 500 | 38ms | 50ms | 220ms | 32.8ms | **5.2ms** |

`e2e` is POST sent → WebSocket frame received. `POST` is the HTTP request alone.
The route responds *before* it broadcasts, so the difference is the fan-out cost.

**Of the 38ms p50 at 500 connections, ~33ms is the Neon INSERT and 5.2ms is
fan-out.** The in-process broadcast is not the bottleneck. The database write is.

### What that means for Phase 2

**Redis pub/sub will not make this faster.** It cannot touch the INSERT that
dominates the number; eliminating fan-out entirely would take 38ms to ~33ms.

That does not make Phase 2 wrong — it changes what it is *for*. Redis is a
**correctness** fix: the moment there are two instances, a POST landing on
instance A must reach subscribers holding sockets on instance B, and
`matchSubscribers` in `ws/server.js` is a per-process `Map`. Today that simply
would not work.

So the expected Phase 2 result is **p50 roughly unchanged, and fan-out that now
works across instances**. If the p50 improves noticeably, something else changed
and it is worth finding out what.

### The other thing worth noticing

p99 degrades far faster than p50 — 67ms → 155ms → 220ms, while p50 moves 33ms →
38ms. The tail is what grows with fan-out. A median would have said nothing was
happening. If a real ceiling exists, that is where it will show up first, and at
12% CPU it is well above 500 connections.

## What Arcjet costs

Same load, Arcjet back in the request path but not blocking:

| Connections | POST p50 baseline | POST p50 with Arcjet | Added |
|---|---|---|---|
| 50 | 31.7ms | 93.4ms | **+61.7ms** |
| 200 | 33.2ms | 93.6ms | **+60.4ms** |
| 500 | 32.8ms | 92.6ms | **+59.8ms** |

**A flat ~60ms per request, independent of connection count — roughly tripling
POST latency.** Server CPU went from 13.7s to 116.6s of CPU time for the same
work, an 8.5x increase, which is the TLS and HTTP client cost of calling out to
Arcjet on every request.

This is why `ARCJET_MODE=DRY_RUN` is not a way to switch Arcjet off: it drops the
enforcement while keeping the call, so it keeps both the latency and the billing.
That property is exactly what makes it useful for pricing the layer.

Worth remembering when reading the baseline: with Arcjet enabled as configured,
the real production p50 for a publish is closer to **93ms than 33ms**, and about
two thirds of that budget belongs to a third party.

## Caveats

- **Loopback is not a network.** Load generator and server share one machine, so
  there is no real network latency in these numbers. Treat them as a floor.
- **The baseline runs with Arcjet and the APM agent disabled.** That is stated in
  each run's `run-context.txt` and visible in `server-stdout.txt`. Phase 2 must
  use the identical configuration or the comparison is meaningless.
- **The Arcjet run overran** (8m04s for a 4m40s test) because a POST hung on a
  Neon `read ETIMEDOUT` — `http_req_duration` max 3m42s, 4 occurrences. That
  distorted its per-plateau *counts* (only 195 publishes attributed to the 500
  plateau, since samples are tagged on completion). The latency figures are
  unaffected and consistent across all three plateaus, and match the run's
  overall median of 93.78ms.
- **Both runs were produced by a version of `baseline.js` with a spin-loop bug**
  in the end-of-run guard: 182,349 and 253,225 no-op iterations against ~3,300
  real ones. It only fires after test time 275s, and the last plateau ends at
  270s, so no plateau measurement is affected. Fixed afterwards; see the
  debugging story in `LEARNING.md`.
- **Peak concurrency is a cross-check, not a direct read.** Adding a read-only
  endpoint exposing `wss.clients.size` would measure it directly, and is worth
  doing before Phase 2 anyway.

## Cleaning up the test data

```sql
DELETE FROM matches WHERE sport = 'loadtest';
```

`commentary.match_id` is `ON DELETE CASCADE`, so this removes the ~5,600
commentary rows the two runs wrote.
