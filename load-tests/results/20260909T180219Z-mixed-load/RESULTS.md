# Load-test results - mixed-load

`20260909T180219Z-mixed-load`

## What was measured

| | |
|---|---|
| Mode | `baseline` |
| Run (UTC) | `20260909T180219Z` |
| Commit | `a253c8e` |
| Uncommitted changes | `yes` |
| ARCJET_ENABLED | `false` |
| ARCJET_MODE | `LIVE` |
| APM agent disabled | `true` |
| Connection plateaus | `100,500` |
| Publish rate | `20/s` |
| Matches | `5` |
| Ramp (s per step) | `30` |
| Hold (s per plateau) | `90` |
| Node | `v24.14.0` |
| k6 | `k6 v2.1.0 (commit/devel, go1.26.4, darwin/arm64)` |
| Machine | `Darwin 25.6.0 arm64` |
| CPUs | `10` |
| RAM (GB) | `24` |
| ulimit -n | `1048576` |

## Headline

- **Peak concurrent WebSocket connections held: 500**
- **Peak established server sockets (OS-measured): 540**
  - difference of 40 is the publisher's HTTP keep-alive pool; a difference far larger than that pool would mean sockets were being dropped
  - (k6's `vus` gauge peaked at 504, but that spans both scenarios)
- **Publish error rate: 0.00%** (0 of 5001 POSTs failed)
- Peak RSS: 327 MB
- Peak CPU: 11% of one core (12.2s CPU total)

## Latency by plateau

`e2e` is POST sent -> WS frame received. `post` is the HTTP request alone (Zod + the Neon INSERT). The route responds *before* it broadcasts, so the gap between them is roughly the fan-out cost - the part Phase 2 changes.

| Connections | e2e p50 | e2e p95 | e2e p99 | e2e max | post p50 | post p95 | post p99 | fan-out (p50 gap) |
|---|---|---|---|---|---|---|---|---|
| 100 | 90.0ms | 194.0ms | 412.0ms | 994.0ms | 89.3ms | 193.9ms | 411.7ms | 0.7ms |
| 500 | 102.0ms | 179.0ms | 350.0ms | 1.18s | 100.5ms | 177.1ms | 326.3ms | 1.5ms |

## Delivery

Each publish should reach every subscriber watching that match. Counts are taken inside the steady plateaus only; a message published just before a boundary can be delivered just after it, so single-digit percentages here are edge effects rather than loss.

| Connections | Published | Expected deliveries | Delivered | Shortfall |
|---|---|---|---|---|
| 100 | 1800 | 36000 | 35968 | 0.1% |
| 500 | 1800 | 180000 | 179877 | 0.1% |

Subscribers and commentary are both spread across 5 match(es), so expected deliveries is publishes x plateau / 5.

## Totals and anomalies

| Metric | Value |
|---|---|
| POSTs succeeded (201) | 5001 |
| POSTs failed | 0 |
| ... sequence conflicts (409) | 0 |
| ... rate limited (429) | 0 |
| WebSocket connections opened | 500 |
| `subscribed` acks received | 500 |
| WebSocket errors | 0 |
| Unexpected/error frames | 0 |
| Commentary frames received (total) | 271901 |
| Frames missing postedAt | 0 |

## Connection / memory timeline

Sampled once a second from the OS. `conns` includes HTTP keep-alives.

```
elapsed_s  conns  rss_mb
        0      0     323  
        5     51     327  #####
       11     67     326  #######
       16     85     242  #########
       21    103     234  ###########
       27    121     234  #############
       32    138     231  ###############
       37    140     197  ###############
       43    140     162  ###############
       48    140     160  ###############
       53    140     174  ###############
       59    140     185  ###############
       64    140     187  ###############
       69    140     146  ###############
       75    140     160  ###############
       80    140     169  ###############
       85    140     170  ###############
       91    140     162  ###############
       96    140     175  ###############
      101    140     181  ###############
      106    140     182  ###############
      112    140     182  ###############
      117    140     186  ###############
      122    141      95  ###############
      128    211      95  #######################
      133    282      95  ###############################
      138    353      99  #######################################
      144    424      99  ###############################################
      149    495     100  #######################################################
      154    540     100  ############################################################
      160    540     101  ############################################################
      165    540     101  ############################################################
      170    540     101  ############################################################
      176    540     102  ############################################################
      181    540     108  ############################################################
      186    540     107  ############################################################
      192    540     105  ############################################################
      197    540     105  ############################################################
      203    540      89  ############################################################
      208    540      90  ############################################################
      213    540      90  ############################################################
      219    540      95  ############################################################
      224    540      92  ############################################################
      229    540      92  ############################################################
      235    540      92  ############################################################
      240    540      92  ############################################################
      245    540      93  ############################################################
      251     40      95  ####
```

## Files

| File | What it is |
|---|---|
| `run-context.txt` | Exact configuration and machine this ran on |
| `summary.json` | k6's full metric export - the input for any re-analysis |
| `k6-stdout.txt` | k6's own terminal summary |
| `samples.csv` | Per-second OS sampling of the server process |
| `server-stdout.txt` | Server stdout, including which protections were off |
