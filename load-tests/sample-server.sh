#!/usr/bin/env bash
#
# Samples the server process once a second for the duration of a load test.
#
# k6 can tell you how many VUs it *intended* to run. It cannot tell you how
# many sockets the server is actually holding - a connection refused, closed
# with 1013, or reaped by the heartbeat still had a VU behind it. This asks the
# operating system instead, which is ground truth.
#
# Two things this deliberately does NOT do:
#
#   It does not try to separate WebSocket sockets from HTTP keep-alive sockets.
#   At the TCP level they are identical, and the publisher scenario holds a
#   pool of keep-alive connections to the same port. `established_conns` is
#   therefore ALL client sockets. report.py subtracts the HTTP baseline, which
#   it measures from the samples taken after the subscribers have disconnected.
#
#   It does not record `ps -o %cpu`. On macOS that is an average over the
#   process's whole lifetime, not an instantaneous reading - under constant
#   load it visibly decays towards zero, which is worse than no number at all.
#   Cumulative CPU time is recorded instead and report.py differentiates it.
#
# Only sockets whose LOCAL side is the server port are counted; the server also
# holds outbound connections to Neon, and those are ESTABLISHED too.
#
# Usage: sample-server.sh <server-pid> <port> <output-csv>

set -uo pipefail

PID="${1:?server pid required}"
PORT="${2:?port required}"
OUT="${3:?output csv path required}"

echo "epoch_s,elapsed_s,established_conns,cpu_time,rss_mb" > "$OUT"

START="$(date +%s)"

while kill -0 "$PID" 2>/dev/null; do
  NOW="$(date +%s)"
  ELAPSED=$(( NOW - START ))

  # ":<port>->" matches only sockets where this process is the local endpoint
  # on the listening port, i.e. accepted client connections.
  CONNS="$(lsof -nP -p "$PID" -a -iTCP -sTCP:ESTABLISHED 2>/dev/null \
           | grep -c ":${PORT}->" || true)"

  # Cumulative CPU time ([[dd-]hh:]mm:ss[.ss]) and resident set size.
  read -r CPUTIME RSS_KB <<< "$(ps -o time=,rss= -p "$PID" 2>/dev/null || echo "0:00.00 0")"
  CPUTIME="${CPUTIME:-0:00.00}"
  RSS_KB="${RSS_KB:-0}"
  RSS_MB=$(( RSS_KB / 1024 ))

  echo "${NOW},${ELAPSED},${CONNS},${CPUTIME},${RSS_MB}" >> "$OUT"

  # Not a precise 1Hz - lsof and ps take time, so samples drift. elapsed_s is
  # recorded per sample rather than assumed, so the drift is visible.
  sleep 1
done
