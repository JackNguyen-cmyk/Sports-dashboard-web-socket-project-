#!/usr/bin/env python3
"""
Turns one results directory into RESULTS.md.

Kept separate from run-baseline.sh so a report can be rebuilt from raw output
without re-running a five-minute test - the raw files are the artifact, this is
just a view over them.

Two numbers here are derived rather than measured, and both are cross-checked:

  Peak WebSocket connections. The OS count (`established_conns`) includes the
  publisher's HTTP keep-alive sockets, which are indistinguishable from
  WebSocket sockets at the TCP level. Each subscriber VU holds exactly one
  socket, so k6's peak VU count is the WebSocket number, and the difference
  between the two should equal the publisher's keep-alive pool. If it does not,
  connections were being dropped - which is a finding, not a rounding error.

  Message loss per plateau. `post_duration{phase:N}` counts publishes inside a
  plateau and `e2e_latency{phase:N}` counts deliveries, so with N subscribers
  all watching one match, deliveries should be publishes x N.
"""
import csv
import json
import pathlib
import re
import sys


def parse_context(path):
    ctx = {}
    if not path.exists():
        return ctx
    for line in path.read_text().splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            ctx[k.strip()] = v.strip()
    return ctx


def parse_cpu_time(text):
    """ps -o time= gives [[dd-]hh:]mm:ss[.ss]. Return seconds as a float."""
    text = text.strip()
    if not text:
        return None
    days = 0
    if "-" in text:
        d, _, text = text.partition("-")
        try:
            days = int(d)
        except ValueError:
            return None
    parts = text.split(":")
    try:
        parts = [float(p) for p in parts]
    except ValueError:
        return None
    seconds = 0.0
    for p in parts:
        seconds = seconds * 60 + p
    return seconds + days * 86400


def fmt_ms(value):
    if value is None:
        return "-"
    if value >= 1000:
        return f"{value / 1000:.2f}s"
    return f"{value:.1f}ms"


def get(metrics, name, stat):
    m = metrics.get(name)
    if not isinstance(m, dict):
        return None
    return m.get(stat)


def main():
    if len(sys.argv) < 2:
        print("usage: report.py <results-dir>", file=sys.stderr)
        return 2

    d = pathlib.Path(sys.argv[1])
    ctx = parse_context(d / "run-context.txt")

    summary_path = d / "summary.json"
    if not summary_path.exists():
        print(f"no summary.json in {d} - k6 did not finish", file=sys.stderr)
        return 1
    metrics = json.loads(summary_path.read_text()).get("metrics", {})

    plateaus = [p.strip() for p in ctx.get("plateaus", "").split(",") if p.strip()]

    # ------------------------------------------------------------ samples ---
    samples = []
    samples_path = d / "samples.csv"
    if samples_path.exists():
        with samples_path.open() as fh:
            for row in csv.DictReader(fh):
                try:
                    samples.append(
                        {
                            "elapsed": int(row["elapsed_s"]),
                            "conns": int(row["established_conns"]),
                            "cpu": parse_cpu_time(row.get("cpu_time", "")),
                            "rss": int(row["rss_mb"]),
                        }
                    )
                except (ValueError, KeyError):
                    continue

    peak_conns = max((s["conns"] for s in samples), default=0)
    peak_rss = max((s["rss"] for s in samples), default=0)

    # Instantaneous CPU, differentiated from cumulative CPU time. ps reports
    # %cpu as a lifetime average on macOS, which decays under constant load.
    peak_cpu_pct = None
    cpu_points = [(s["elapsed"], s["cpu"]) for s in samples if s["cpu"] is not None]
    for (t0, c0), (t1, c1) in zip(cpu_points, cpu_points[1:]):
        dt = t1 - t0
        if dt <= 0:
            continue
        pct = (c1 - c0) / dt * 100.0
        if peak_cpu_pct is None or pct > peak_cpu_pct:
            peak_cpu_pct = pct
    total_cpu_s = (
        cpu_points[-1][1] - cpu_points[0][1] if len(cpu_points) >= 2 else None
    )

    peak_vus = get(metrics, "vus", "max") or 0
    # vus counts both scenarios. The publisher's VUs are short-lived and few;
    # subscribers dominate. Reported as-is with that caveat rather than guessed.
    keepalive_delta = peak_conns - peak_vus

    # ----------------------------------------------------------- latency ----
    rows = []
    for name in plateaus:
        e2e = f"e2e_latency{{phase:{name}}}"
        post = f"post_duration{{phase:{name}}}"
        published = get(metrics, post, "count") or 0
        delivered = get(metrics, e2e, "count") or 0
        expected = published * int(name) if name.isdigit() else 0
        loss = (1 - delivered / expected) * 100 if expected else None
        rows.append(
            {
                "plateau": name,
                "e2e_p50": get(metrics, e2e, "med"),
                "e2e_p95": get(metrics, e2e, "p(95)"),
                "e2e_p99": get(metrics, e2e, "p(99)"),
                "e2e_max": get(metrics, e2e, "max"),
                "post_p50": get(metrics, post, "med"),
                "post_p95": get(metrics, post, "p(95)"),
                "post_p99": get(metrics, post, "p(99)"),
                "published": published,
                "delivered": delivered,
                "expected": expected,
                "loss": loss,
            }
        )

    publish_ok = get(metrics, "publish_ok", "count") or 0
    publish_fail = get(metrics, "publish_fail", "count") or 0
    conflicts = get(metrics, "publish_seq_conflict_409", "count") or 0
    limited = get(metrics, "publish_rate_limited_429", "count") or 0
    ws_connected = get(metrics, "ws_connected", "count") or 0
    ws_acks = get(metrics, "ws_subscribe_acks", "count") or 0
    ws_errors = get(metrics, "ws_errors", "count") or 0
    ws_proto = get(metrics, "ws_protocol_errors", "count") or 0
    no_ts = get(metrics, "commentary_without_timestamp", "count") or 0
    received = get(metrics, "commentary_received", "count") or 0
    publish_total = publish_ok + publish_fail
    error_rate = (publish_fail / publish_total * 100) if publish_total else 0.0

    # ------------------------------------------------------------- render ---
    L = []
    A = L.append

    A(f"# Load-test results - {ctx.get('label', d.name)}")
    A("")
    A(f"`{d.name}`")
    A("")

    A("## What was measured")
    A("")
    A("| | |")
    A("|---|---|")
    for key, label in [
        ("mode", "Mode"),
        ("timestamp_utc", "Run (UTC)"),
        ("git_sha", "Commit"),
        ("git_dirty", "Uncommitted changes"),
        ("arcjet_enabled", "ARCJET_ENABLED"),
        ("arcjet_mode", "ARCJET_MODE"),
        ("apm_disabled", "APM agent disabled"),
        ("plateaus", "Connection plateaus"),
        ("publish_rate", "Publish rate"),
        ("match_count", "Matches"),
        ("ramp_s", "Ramp (s per step)"),
        ("hold_s", "Hold (s per plateau)"),
        ("node", "Node"),
        ("k6", "k6"),
        ("uname", "Machine"),
        ("cpus", "CPUs"),
        ("mem_gb", "RAM (GB)"),
        ("ulimit_n", "ulimit -n"),
    ]:
        if key in ctx:
            A(f"| {label} | `{ctx[key]}` |")
    A("")

    A("## Headline")
    A("")
    A(f"- **Peak concurrent WebSocket connections held: {peak_vus}**")
    A(f"- **Peak established server sockets (OS-measured): {peak_conns}**")
    A(
        f"  - difference of {keepalive_delta} is the publisher's HTTP keep-alive pool; "
        "a difference far larger than that pool would mean sockets were being dropped"
    )
    A(f"- **Publish error rate: {error_rate:.2f}%** ({publish_fail} of {publish_total} POSTs failed)")
    A(f"- Peak RSS: {peak_rss} MB")
    if peak_cpu_pct is not None:
        A(f"- Peak CPU: {peak_cpu_pct:.0f}% of one core" + (f" ({total_cpu_s:.1f}s CPU total)" if total_cpu_s else ""))
    A("")

    A("## Latency by plateau")
    A("")
    A(
        "`e2e` is POST sent -> WS frame received. `post` is the HTTP request alone "
        "(Zod + the Neon INSERT). The route responds *before* it broadcasts, so the "
        "gap between them is roughly the fan-out cost - the part Phase 2 changes."
    )
    A("")
    A("| Connections | e2e p50 | e2e p95 | e2e p99 | e2e max | post p50 | post p95 | post p99 | fan-out (p50 gap) |")
    A("|---|---|---|---|---|---|---|---|---|")
    for r in rows:
        gap = (
            r["e2e_p50"] - r["post_p50"]
            if r["e2e_p50"] is not None and r["post_p50"] is not None
            else None
        )
        A(
            f"| {r['plateau']} | {fmt_ms(r['e2e_p50'])} | {fmt_ms(r['e2e_p95'])} | "
            f"{fmt_ms(r['e2e_p99'])} | {fmt_ms(r['e2e_max'])} | {fmt_ms(r['post_p50'])} | "
            f"{fmt_ms(r['post_p95'])} | {fmt_ms(r['post_p99'])} | {fmt_ms(gap)} |"
        )
    A("")

    A("## Delivery")
    A("")
    A(
        "With every subscriber watching one match, each publish should reach every "
        "connection. Counts are taken inside the steady plateaus only; a message "
        "published just before a boundary can be delivered just after it, so single-"
        "digit percentages here are edge effects rather than loss."
    )
    A("")
    A("| Connections | Published | Expected deliveries | Delivered | Shortfall |")
    A("|---|---|---|---|---|")
    for r in rows:
        loss = f"{r['loss']:.1f}%" if r["loss"] is not None else "-"
        A(
            f"| {r['plateau']} | {r['published']} | {r['expected']} | "
            f"{r['delivered']} | {loss} |"
        )
    A("")

    A("## Totals and anomalies")
    A("")
    A("| Metric | Value |")
    A("|---|---|")
    A(f"| POSTs succeeded (201) | {publish_ok} |")
    A(f"| POSTs failed | {publish_fail} |")
    A(f"| ... sequence conflicts (409) | {conflicts} |")
    A(f"| ... rate limited (429) | {limited} |")
    A(f"| WebSocket connections opened | {ws_connected} |")
    A(f"| `subscribed` acks received | {ws_acks} |")
    A(f"| WebSocket errors | {ws_errors} |")
    A(f"| Unexpected/error frames | {ws_proto} |")
    A(f"| Commentary frames received (total) | {received} |")
    A(f"| Frames missing postedAt | {no_ts} |")
    A("")

    notes = []
    if limited:
        notes.append(
            f"**{limited} requests were rate limited (429).** Arcjet was still in the "
            "request path - this run is not a clean baseline."
        )
    if conflicts:
        notes.append(
            f"**{conflicts} sequence conflicts (409).** Two publisher VUs picked the "
            "same (match_id, sequence); SEQ_STRIDE in baseline.js is too small."
        )
    if no_ts:
        notes.append(
            f"**{no_ts} frames arrived without a postedAt timestamp.** The latency "
            "numbers are computed from that field, so they are incomplete."
        )
    if ws_connected and ws_acks < ws_connected:
        notes.append(
            f"**{ws_connected - ws_acks} connections never got a `subscribed` ack.** "
            "They were counted as connected but may not have been receiving."
        )
    if notes:
        A("## Warnings")
        A("")
        for n in notes:
            A(f"- {n}")
        A("")

    if samples:
        A("## Connection / memory timeline")
        A("")
        A("Sampled once a second from the OS. `conns` includes HTTP keep-alives.")
        A("")
        A("```")
        A("elapsed_s  conns  rss_mb")
        step = max(1, len(samples) // 40)
        for s in samples[::step]:
            bar = "#" * min(60, s["conns"] * 60 // max(peak_conns, 1))
            A(f"{s['elapsed']:>9}  {s['conns']:>5}  {s['rss']:>6}  {bar}")
        A("```")
        A("")

    A("## Files")
    A("")
    A("| File | What it is |")
    A("|---|---|")
    A("| `run-context.txt` | Exact configuration and machine this ran on |")
    A("| `summary.json` | k6's full metric export - the input for any re-analysis |")
    A("| `k6-stdout.txt` | k6's own terminal summary |")
    A("| `samples.csv` | Per-second OS sampling of the server process |")
    A("| `server-stdout.txt` | Server stdout, including which protections were off |")
    A("")

    out = d / "RESULTS.md"
    out.write_text("\n".join(L))
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
