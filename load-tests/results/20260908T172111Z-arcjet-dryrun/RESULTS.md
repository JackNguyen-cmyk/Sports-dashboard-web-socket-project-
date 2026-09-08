# Load-test results - arcjet-dryrun

`20260908T172111Z-arcjet-dryrun`

## What was measured

| | |
|---|---|
| Mode | `arcjet-dryrun` |
| Run (UTC) | `20260908T172111Z` |
| Commit | `1ea98bb` |
| Uncommitted changes | `yes` |
| ARCJET_ENABLED | `<unset, so ON>` |
| ARCJET_MODE | `DRY_RUN` |
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

- **Peak concurrent WebSocket connections held: 524**
- **Peak established server sockets (OS-measured): 526**
  - difference of 2 is the publisher's HTTP keep-alive pool; a difference far larger than that pool would mean sockets were being dropped
- **Publish error rate: 0.14%** (4 of 2794 POSTs failed)
- Peak RSS: 348 MB
- Peak CPU: 54% of one core (116.6s CPU total)

## Latency by plateau

`e2e` is POST sent -> WS frame received. `post` is the HTTP request alone (Zod + the Neon INSERT). The route responds *before* it broadcasts, so the gap between them is roughly the fan-out cost - the part Phase 2 changes.

| Connections | e2e p50 | e2e p95 | e2e p99 | e2e max | post p50 | post p95 | post p99 | fan-out (p50 gap) |
|---|---|---|---|---|---|---|---|---|
| 50 | 94.0ms | 136.0ms | 260.0ms | 276.0ms | 93.4ms | 133.6ms | 258.7ms | 0.6ms |
| 200 | 96.0ms | 136.0ms | 262.0ms | 345.0ms | 93.6ms | 133.8ms | 259.2ms | 2.4ms |
| 500 | 98.0ms | 175.0ms | 278.0ms | 293.0ms | 92.6ms | 170.1ms | 266.6ms | 5.4ms |

## Delivery

With every subscriber watching one match, each publish should reach every connection. Counts are taken inside the steady plateaus only; a message published just before a boundary can be delivered just after it, so single-digit percentages here are edge effects rather than loss.

| Connections | Published | Expected deliveries | Delivered | Shortfall |
|---|---|---|---|---|
| 50 | 599 | 29950 | 29944 | 0.0% |
| 200 | 600 | 120000 | 119988 | 0.0% |
| 500 | 195 | 97500 | 97475 | 0.0% |

## Totals and anomalies

| Metric | Value |
|---|---|
| POSTs succeeded (201) | 2790 |
| POSTs failed | 4 |
| ... sequence conflicts (409) | 0 |
| ... rate limited (429) | 0 |
| WebSocket connections opened | 500 |
| `subscribed` acks received | 500 |
| WebSocket errors | 0 |
| Unexpected/error frames | 0 |
| Commentary frames received (total) | 635086 |
| Frames missing postedAt | 0 |

## Connection / memory timeline

Sampled once a second from the OS. `conns` includes HTTP keep-alives.

```
elapsed_s  conns  rss_mb
        0      0     347  
        7     30     305  ###
       13     40     306  ####
       19     50     316  #####
       26     61     307  ######
       32     70     320  #######
       38     70     314  #######
       45     70     326  #######
       51     70     315  #######
       58     70     328  #######
       64     70     309  #######
       70     70     273  #######
       77     70     265  #######
       83     70     286  #######
       90     70     250  #######
       96     96     251  ##########
      102    128     279  ##############
      109    160     260  ##################
      115    192     261  #####################
      122    220     252  #########################
      128    220     255  #########################
      134    220     268  #########################
      141    220     255  #########################
      147    220     258  #########################
      154    220     258  #########################
      160    220     256  #########################
      166    220     255  #########################
      173    220     256  #########################
      179    220     259  #########################
      186    268     259  ##############################
      192    332     256  #####################################
      198    396     265  #############################################
      205    460     281  ####################################################
      211    520     281  ###########################################################
      218    520     260  ###########################################################
      224    520     263  ###########################################################
      434    507     184  #########################################################
      440    526     137  ############################################################
      447    526     176  ############################################################
      453    526     167  ############################################################
      459    526     174  ############################################################
      466    526     172  ############################################################
      472    526     202  ############################################################
      479    526     205  ############################################################
```

## Files

| File | What it is |
|---|---|
| `run-context.txt` | Exact configuration and machine this ran on |
| `summary.json` | k6's full metric export - the input for any re-analysis |
| `k6-stdout.txt` | k6's own terminal summary |
| `samples.csv` | Per-second OS sampling of the server process |
| `server-stdout.txt` | Server stdout, including which protections were off |
