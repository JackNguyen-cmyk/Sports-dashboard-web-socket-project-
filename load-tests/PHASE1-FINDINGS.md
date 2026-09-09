# Phase 1 findings — the "before" number

Three runs against the system as it exists today: one node process, one in-memory
`matchSubscribers` Map, one Neon database. Raw output in `results/`.

Published summary: <https://claude.ai/code/artifact/1fa787c4-e844-450c-ad71-5d24d71da5ea>

| Run | Shape | Purpose |
|---|---|---|
| `20260909T180219Z-mixed-load` | 5 matches, 100 → 500 subscribers, 20 writes/s | **The headline baseline.** Realistic mixed load. |
| `20260908T171523Z-baseline` | 1 match, 50 → 200 → 500, 10 writes/s | Maximum fan-out per event — isolates the broadcast loop. |
| `20260908T172111Z-arcjet-dryrun` | as above, Arcjet in the path | Prices the protection layer. |

All three ran with `ARCJET_ENABLED=false` and `APMINSIGHT_AGENT_DISABLE=true`
except the last, which put Arcjet back in `DRY_RUN`. Phase 2 must reproduce the
same flags or the comparison is meaningless.

## Headline — the mixed-load run

**500 concurrent subscribers across 5 matches, 20 writes/s, 4m10s.**

- Peak concurrent WebSocket connections: **500** (OS-measured 540 sockets; the 40
  difference is the publisher's HTTP keep-alive pool, which is what confirms no
  socket was dropped)
- Error rate: **0.00%** — 0 of 5,001 writes failed. No 409s, no 429s, no socket errors
- Delivered **271,901 frames**; 179,877 of 180,000 expected inside the 500 plateau (99.93%)
- Peak CPU **11% of one core** (12.2s total), RSS flat at 327MB

| Plateau | e2e p50 | e2e p95 | e2e p99 | e2e max | write p50 | **fan-out** |
|---|---|---|---|---|---|---|
| 100 connections | 90.0ms | 194.0ms | 412.0ms | 994ms | 89.3ms | **0.7ms** |
| 500 connections | 102.0ms | 179.0ms | 350.0ms | 1.18s | 100.5ms | **1.5ms** |

`e2e` is POST sent → frame received. `write` is the HTTP request alone. The route
responds *before* it broadcasts, so the difference is the fan-out cost.

## What the numbers say

**The database write is the latency; fan-out is a rounding error.** Of the 102ms
median at 500 connections, 100.5ms is the Neon `INSERT` and 1.5ms is the broadcast.
Removing fan-out entirely would take 102ms to about 100.5ms.

**So Redis pub/sub is a correctness fix, not a latency one.** With two instances a
write landing on A must reach subscribers holding sockets on B, and
`matchSubscribers` is a per-process `Map` — today that would not work at all.
Expect Phase 2's median to be roughly unchanged. If it improves noticeably,
something else changed and it is worth finding out what.

**Fan-out cost tracks subscribers *per match*, not subscribers total.** Pooling
both runs:

| Subscribers on one match | 20 | 50 | 100 | 200 | 500 |
|---|---|---|---|---|---|
| Fan-out cost | 0.7ms | 1.3ms | 1.5ms | 2.8ms | 5.2ms |

Roughly 1ms per 100 subscribers, and sublinear at the top because the single
`JSON.stringify` per broadcast is amortised over more sockets. Spreading the same
500 connections over 5 matches cut fan-out from 5.2ms to 1.5ms. Sharding by match
is already an effective lever.

**The p99 at 100 connections is worse than at 500** (412ms vs 350ms). Fan-out
cannot explain that, since fan-out rose. The tail belongs to write variance, and
the 100 plateau ran earlier, closer to Neon waking up.

**The write path is the thing to watch, and it has a lead worth chasing.**
Doubling the write rate from 10/s to 20/s moved the median write from ~33ms to
~100ms — threefold cost for twofold load. Pool contention (`pg` defaults to 10
clients) and Neon behaviour are both plausible. The two runs were a day apart, so
this is a lead, not a conclusion.

## What Arcjet costs

Same load, Arcjet back in the path but not blocking:

| Connections | write p50 without | write p50 with | Added |
|---|---|---|---|
| 50 | 31.7ms | 93.4ms | **+61.7ms** |
| 200 | 33.2ms | 93.6ms | **+60.4ms** |
| 500 | 32.8ms | 92.6ms | **+59.8ms** |

**A flat ~60ms per request, independent of connection count**, and server CPU time
went from 13.7s to 116.6s for the same work — the TLS and HTTP client cost of
calling out on every request. This is why `ARCJET_MODE=DRY_RUN` is not a way to
switch Arcjet off: it drops the enforcement while keeping the call.

## Caveats

- **Loopback is not a network.** Generator and server share one machine. Floor, not
  a production prediction.
- **The Arcjet run overran** (8m04s for a 4m40s test) because a write hung on a Neon
  `read ETIMEDOUT` — `http_req_duration` max 3m42s, 4 occurrences. That distorted
  its per-plateau counts; its latencies are consistent across all three plateaus
  and match the run's overall median of 93.78ms.
- **The two 2026-09-08 runs were produced by a `baseline.js` with a spin-loop** in
  its end-of-run guard (182k and 253k no-op iterations against ~3.3k real ones). It
  only fires after test time 275s and the last plateau ends at 270s, so no plateau
  measurement is affected. Fixed; see the debugging story in `LEARNING.md`.
- **Those two runs also tagged samples on completion rather than send**, which is
  why the Arcjet run credited only 195 of 600 writes to its last plateau. Fixed for
  the mixed-load run — both sides now tag by send time.
- **Peak concurrency is cross-checked, not read directly.** A read-only endpoint
  exposing `wss.clients.size` would measure it outright, and is worth adding before
  there is a second instance to account for.

## Cleaning up

```sql
DELETE FROM matches WHERE sport = 'loadtest';
```

`commentary.match_id` is `ON DELETE CASCADE`. The three runs wrote roughly 10,600
commentary rows across 7 matches.
