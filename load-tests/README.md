# Load tests

Phase 1 of the scaling roadmap: a measured "before" picture of the system as it
exists today — one node process, one in-memory `matchSubscribers` Map, one Neon
database — so that Phase 2 (Redis pub/sub) can be measured against something.

The point is not the absolute numbers. It is having a number at all, taken under
a configuration written down precisely enough to reproduce.

## Where this lives, and why it is not in `src/`

`src/` is the project root for the *application* — that is where `package.json`,
`node_modules` and `.env` live, and every `npm` command must run from there.

These load tests are not part of the application. k6 is a standalone Go binary
that runs its own JavaScript runtime; it does not use `node_modules` and needs
no `npm install`. Putting them under `src/` would add a directory to the
deployed app that only exists for testing. They live at the repository root
instead.

**Do not run `npm install` from the repository root.** It creates a stray root
`package.json` and `node_modules` that nothing uses. Nothing here needs it.

## Requirements

- [k6](https://k6.io) — `brew install k6`. Developed against v2.1.0.
- `lsof`, `python3` — both ship with macOS.
- A working `src/.env` with `DATABASE_URL`. The test writes real rows to Neon.

## Running it

```bash
cd load-tests
./run-baseline.sh                     # the Phase 1 baseline
MODE=arcjet-dryrun ./run-baseline.sh  # the same load, with Arcjet back in the path
```

Each run creates `results/<UTC-timestamp>-<label>/` containing the raw output
and a generated `RESULTS.md`.

The script starts and stops the server itself. It refuses to run if something is
already listening on the port — a server someone else started has unknown flags,
and a measurement whose configuration you cannot state is not comparable to
anything.

### Knobs

| Variable | Default | Meaning |
|---|---|---|
| `PLATEAUS` | `50,200,500` | Connection counts to hold, in order |
| `RAMP_S` | `30` | Seconds spent ramping to each plateau |
| `HOLD_S` | `60` | Seconds held at each plateau (this is the measured window) |
| `PUBLISH_RATE` | `10` | `POST /matches/:id/commentary` per second |
| `MATCH_COUNT` | `1` | Matches to spread subscribers and commentary across |
| `PORT` | `8000` | Server port |
| `APP_DIR` | `../src` | Where to start the server from |

A short run to check the harness still works, without waiting five minutes:

```bash
PLATEAUS=5 RAMP_S=3 HOLD_S=5 PUBLISH_RATE=2 LABEL=smoke ./run-baseline.sh
```

## What the two modes are for

**`baseline`** sets `ARCJET_ENABLED=false` and `APMINSIGHT_AGENT_DISABLE=true`,
taking both third-party layers out of the request path entirely.

This is not cheating, but it does have to be stated. Arcjet's limits are sized
for real users — 5 WebSocket upgrades per 2 seconds, 50 HTTP requests per 10
seconds. Ramping to 500 connections through a 5-per-2s gate needs 200 seconds of
pure admission control, and a 10/s publish stream against a 5/s limit comes back
half `429`. The ramp would be measuring Arcjet's sliding window, not this
server. On top of that, every `protect()` call is a network round trip — 47–226ms
measured — landing directly in the p95 we are trying to attribute to fan-out.

Note that `ARCJET_MODE=DRY_RUN` does **not** achieve this. DRY_RUN drops the
enforcement but still makes the call, so it keeps both the latency and the
billing.

**`arcjet-dryrun`** is that property used deliberately: same load, Arcjet back in
the path and evaluating but not blocking. The difference between the two runs is
what the protection layer costs. Running both means you can say which part of
the latency is yours.

> **This mode spends real Arcjet quota.** Every upgrade and every POST is a
> billed API call, so a full default run is roughly 500 + 2,800 = 3,300 calls.
> Pricing a per-request layer does not need the whole ramp - the per-call cost
> does not depend on how many connections are open. Use a short run:
>
> ```bash
> MODE=arcjet-dryrun PLATEAUS=50 RAMP_S=10 HOLD_S=30 PUBLISH_RATE=5 ./run-baseline.sh
> ```
>
> That is ~200 calls for the same answer.

## How the latency number is produced

"Time from POST to WS message received" is awkward to measure in k6, because the
POST happens in one VU and the WebSocket frame arrives in a different one, and
k6 VUs have completely isolated JS memory — there is no shared variable to park
a start timestamp in.

So the timestamp travels inside the payload. The publisher stamps
`metadata.postedAt = Date.now()` immediately before sending; the row is
persisted with that metadata; `broadcastCommentaryCreated` sends the row back
out; the subscriber computes `Date.now() - postedAt`. Both VUs are in the same
k6 process on one machine, so it is the same clock.

**This is only valid on a single load generator.** Split the publisher and the
subscribers across machines and the clocks must be synchronised first, or the
number is meaningless.

### Why there are two latency metrics

`e2e_latency` bundles everything: HTTP, Zod, the Neon `INSERT` round trip, JSON
serialisation and the fan-out loop. Neon is a network database, so the INSERT is
likely to dominate — and Redis cannot make an INSERT faster. Reporting only the
end-to-end number would hide any Phase 2 improvement behind a constant.

`post_duration` is the HTTP request on its own, recorded from the publisher.
Because `routes/commentary.js` responds *before* it broadcasts, the gap between
the two is roughly the fan-out cost. That gap is the number Phase 2 should move.

### Why samples are tagged by plateau

A single p99 across the whole run blends the 50-connection regime with the
500-connection regime and describes neither. Every sample is tagged with the
plateau it fell in, and thresholds are declared per plateau because k6 only
emits tagged sub-metrics for metrics that carry one. Samples during a ramp are
tagged `ramp` and excluded — the connection count is still moving.

## How "peak concurrent connections" is counted

`sample-server.sh` asks the OS once a second how many ESTABLISHED sockets the
server process holds on its listening port. That is ground truth, and it is the
only one of these numbers the application cannot lie about.

It has one limitation: at the TCP level a WebSocket socket and an HTTP
keep-alive socket are identical, and the publisher holds a pool of keep-alives
to the same port. So `established_conns` is *all* client sockets.

Each subscriber VU holds exactly one WebSocket for its whole iteration, so k6's
peak VU count is the WebSocket number, and the difference between the two should
equal the publisher's keep-alive pool. The two numbers check each other: a gap
much larger than that pool means sockets were being dropped.

If you want this measured directly rather than derived, the server would need to
expose `wss.clients.size` on a read-only endpoint. That is worth adding before
Phase 2 anyway — once there is more than one instance, you will want per-instance
connection counts to prove the fan-out actually crosses instances.

## Test data

Every run creates fresh matches with `sport = 'loadtest'`. Fresh matches keep
each run's `(match_id, sequence)` space empty, so a re-run can never collide with
rows left behind by the last one — the unique index would turn that into a `409`.

The rows are real and they stay in Neon. `commentary.match_id` is
`ON DELETE CASCADE`, so deleting the matches removes their commentary too:

```sql
DELETE FROM matches WHERE sport = 'loadtest';
```

A default run at 10/s for ~4m40s writes roughly 2,800 commentary rows.

## Reading the output

| File | What it is |
|---|---|
| `RESULTS.md` | Generated report — start here |
| `run-context.txt` | Exact configuration, commit, and machine |
| `summary.json` | k6's full metric export; the input for any re-analysis |
| `k6-stdout.txt` | k6's own terminal summary |
| `samples.csv` | Per-second OS sampling of the server process |
| `server-stdout.txt` | Server stdout, including which protections were disabled |

`report.py` is deliberately separate from the runner, so a report can be rebuilt
from raw output without re-running the test:

```bash
python3 report.py results/<dir>
```

## Things that are expected, and not bugs

- **Interrupted iterations at the end of the run.** Subscriber iterations are
  long-lived by design — one held socket each — so k6 stops them at ramp-down
  rather than waiting.
- **`iteration_duration` is enormous for the subscribers scenario.** Same
  reason: an iteration *is* the lifetime of a connection.
- **A non-zero k6 exit code (99).** Thresholds here are deliberately loose and
  exist mainly to force the per-plateau rows into the summary. A crossed
  threshold is information, not a failed run.
- **Single-digit shortfall in the delivery table.** A message published just
  before a plateau boundary can be delivered just after it, and gets counted on
  the other side.

## Caveats worth stating out loud

- **Loopback is not a network.** The load generator and the server are on the
  same machine, so these latencies have no real network in them. Treat them as a
  floor, not a production prediction.
- **k6 and the server compete for the same 10 cores.** At the top plateau the
  load generator is doing real work too. If the server's CPU sample approaches
  one saturated core, the bottleneck may be measurement, not the server.
- **Neon is a shared, network database that can autosuspend.** `setup()` warms
  it with a query before the measured window, but a cold compute can still skew
  the first plateau.
