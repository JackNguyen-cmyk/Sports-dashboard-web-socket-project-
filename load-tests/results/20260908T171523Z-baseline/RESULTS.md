# Load-test results - baseline

`20260908T171523Z-baseline`

## What was measured

| | |
|---|---|
| Mode | `baseline` |
| Run (UTC) | `20260908T171523Z` |
| Commit | `1ea98bb` |
| Uncommitted changes | `yes` |
| ARCJET_ENABLED | `false` |
| ARCJET_MODE | `LIVE` |
| APM agent disabled | `true` |
| Connection plateaus | `50,200,500` |
| Publish rate | `10/s` |
| Matches | `1` |
| Ramp (s per step) | `30` |
| Hold (s per plateau) | `60` |
| Node | `v24.14.0` |
| k6 | `k6 v2.1.0 (commit/devel, go1.26.4, darwin/arm64)` |
| Machine | `Darwin 25.6.0 arm64` |
| CPUs | `10` |
| RAM (GB) | `24` |
| ulimit -n | `1048576` |

## Headline

- **Peak concurrent WebSocket connections held: 500**
- **Peak established server sockets (OS-measured): 520**
  - difference of 20 is the publisher's HTTP keep-alive pool; a difference far larger than that pool would mean sockets were being dropped
  - (k6's `vus` gauge peaked at 501, but that spans both scenarios)
- **Publish error rate: 0.00%** (0 of 2801 POSTs failed)
- Peak RSS: 327 MB
- Peak CPU: 12% of one core (13.7s CPU total)

## Latency by plateau

`e2e` is POST sent -> WS frame received. `post` is the HTTP request alone (Zod + the Neon INSERT). The route responds *before* it broadcasts, so the gap between them is roughly the fan-out cost - the part Phase 2 changes.

| Connections | e2e p50 | e2e p95 | e2e p99 | e2e max | post p50 | post p95 | post p99 | fan-out (p50 gap) |
|---|---|---|---|---|---|---|---|---|
| 50 | 33.0ms | 49.0ms | 67.0ms | 353.0ms | 31.7ms | 48.4ms | 65.6ms | 1.3ms |
| 200 | 36.0ms | 43.0ms | 155.1ms | 275.0ms | 33.2ms | 39.8ms | 150.9ms | 2.8ms |
| 500 | 38.0ms | 50.0ms | 220.0ms | 526.0ms | 32.8ms | 40.0ms | 217.2ms | 5.2ms |

## Delivery

Each publish should reach every subscriber watching that match. Counts are taken inside the steady plateaus only; a message published just before a boundary can be delivered just after it, so single-digit percentages here are edge effects rather than loss.

| Connections | Published | Expected deliveries | Delivered | Shortfall |
|---|---|---|---|---|
| 50 | 600 | 30000 | 29997 | 0.0% |
| 200 | 600 | 120000 | 119996 | 0.0% |
| 500 | 600 | 300000 | 299994 | 0.0% |

Subscribers and commentary are both spread across 1 match(es), so expected deliveries is publishes x plateau / 1.

## Totals and anomalies

| Metric | Value |
|---|---|
| POSTs succeeded (201) | 2801 |
| POSTs failed | 0 |
| ... sequence conflicts (409) | 0 |
| ... rate limited (429) | 0 |
| WebSocket connections opened | 500 |
| `subscribed` acks received | 500 |
| WebSocket errors | 0 |
| Unexpected/error frames | 0 |
| Commentary frames received (total) | 641179 |
| Frames missing postedAt | 0 |

## Connection / memory timeline

Sampled once a second from the OS. `conns` includes HTTP keep-alives.

```
elapsed_s  conns  rss_mb
        0      1     325  
        7     30     326  ###
       13     41     327  ####
       20     52     239  ######
       26     62     233  #######
       32     70     233  ########
       39     70     234  ########
       45     70     234  ########
       51     70     237  ########
       58     70     237  ########
       64     70     237  ########
       71     70     237  ########
       77     70     243  ########
       83     70     243  ########
       90     70     243  ########
       96     99     243  ###########
      103    131     243  ###############
      109    163     243  ##################
      115    195     243  ######################
      122    220     244  #########################
      128    220     244  #########################
      134    220     117  #########################
      141    220     117  #########################
      147    220     117  #########################
      154    220     117  #########################
      160    220     117  #########################
      166    220     117  #########################
      173    220     118  #########################
      179    220     118  #########################
      186    273     109  ###############################
      192    337     110  ######################################
      198    401     113  ##############################################
      205    465     113  #####################################################
      211    520     114  ############################################################
      217    520     114  ############################################################
      224    520     114  ############################################################
      230    520     114  ############################################################
      237    520     109  ############################################################
      243    520     109  ############################################################
      249    520     108  ############################################################
      256    520     108  ############################################################
      262    520     108  ############################################################
      269    520     112  ############################################################
      275    520     112  ############################################################
```

## Files

| File | What it is |
|---|---|
| `run-context.txt` | Exact configuration and machine this ran on |
| `summary.json` | k6's full metric export - the input for any re-analysis |
| `k6-stdout.txt` | k6's own terminal summary |
| `samples.csv` | Per-second OS sampling of the server process |
| `server-stdout.txt` | Server stdout, including which protections were off |
