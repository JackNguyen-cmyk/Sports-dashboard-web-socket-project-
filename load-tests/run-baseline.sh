#!/usr/bin/env bash
#
# Runs one load-test scenario end to end and writes everything it needs to be
# reproduced into a timestamped results directory.
#
# It starts the server itself rather than assuming one is running, because the
# configuration the server booted with (was Arcjet in the path? was the APM
# agent instrumenting?) is part of the measurement. A number taken against a
# server someone started by hand, with unknown flags, is not comparable to
# anything.
#
#   ./run-baseline.sh                    # the Phase 1 baseline
#   MODE=arcjet-dryrun ./run-baseline.sh # same load, Arcjet back in the path
#
# Env overrides: MODE LABEL PORT APP_DIR BASE_URL MATCH_COUNT PUBLISH_RATE
#                PLATEAUS RAMP_S HOLD_S

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

MODE="${MODE:-baseline}"
PORT="${PORT:-8000}"
APP_DIR="${APP_DIR:-$REPO_ROOT/src}"
BASE_URL="${BASE_URL:-http://localhost:$PORT}"

MATCH_COUNT="${MATCH_COUNT:-1}"
PUBLISH_RATE="${PUBLISH_RATE:-10}"
PLATEAUS="${PLATEAUS:-50,200,500}"
RAMP_S="${RAMP_S:-30}"
HOLD_S="${HOLD_S:-60}"

case "$MODE" in
  baseline)
    # Arcjet fully out of the request path: no enforcement AND no network call.
    # Its real limits (5 WS upgrades/2s, 50 HTTP req/10s) would gate the entire
    # ramp, and each protect() adds a 47-226ms round trip to the latency we are
    # trying to attribute to fan-out.
    ARCJET_ENABLED_VAL="false"
    ARCJET_MODE_VAL="LIVE"
    APM_DISABLE_VAL="true"
    DEFAULT_LABEL="baseline"
    ;;
  arcjet-dryrun)
    # Arcjet back in the path but not blocking, to price the layer itself.
    # DRY_RUN still makes the call - that is exactly why it works here, and
    # exactly why it is useless as a way to switch Arcjet off.
    ARCJET_ENABLED_VAL=""
    ARCJET_MODE_VAL="DRY_RUN"
    APM_DISABLE_VAL="true"
    DEFAULT_LABEL="arcjet-dryrun"
    ;;
  *)
    echo "unknown MODE '$MODE' (expected: baseline | arcjet-dryrun)" >&2
    exit 2
    ;;
esac

LABEL="${LABEL:-$DEFAULT_LABEL}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RESULTS_DIR="$SCRIPT_DIR/results/${STAMP}-${LABEL}"
mkdir -p "$RESULTS_DIR"

echo "==> results -> $RESULTS_DIR"

# --------------------------------------------------------------- preflight ---

for tool in k6 node lsof; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing required tool: $tool" >&2; exit 1; }
done

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is already in use - refusing to start." >&2
  echo "a server you did not start has unknown flags, which makes the run" >&2
  echo "uncomparable. stop it first:  lsof -nP -iTCP:$PORT -sTCP:LISTEN" >&2
  exit 1
fi

if [ ! -d "$APP_DIR/node_modules" ]; then
  echo "no node_modules in $APP_DIR - run 'cd $APP_DIR && npm install' first." >&2
  exit 1
fi

# ------------------------------------------------------- record the context ---

{
  echo "mode:            $MODE"
  echo "label:           $LABEL"
  echo "timestamp_utc:   $STAMP"
  echo "git_sha:         $(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "git_dirty:       $(test -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" && echo yes || echo no)"
  echo "node:            $(node --version)"
  echo "k6:              $(k6 version 2>&1 | head -1)"
  echo "uname:           $(uname -srm)"
  echo "cpus:            $(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo unknown)"
  echo "mem_gb:          $(sysctl -n hw.memsize 2>/dev/null | awk '{printf "%.0f", $1/1073741824}' || echo unknown)"
  echo "ulimit_n:        $(ulimit -n)"
  echo "arcjet_enabled:  ${ARCJET_ENABLED_VAL:-<unset, so ON>}"
  echo "arcjet_mode:     $ARCJET_MODE_VAL"
  echo "apm_disabled:    $APM_DISABLE_VAL"
  echo "port:            $PORT"
  echo "base_url:        $BASE_URL"
  echo "match_count:     $MATCH_COUNT"
  echo "publish_rate:    $PUBLISH_RATE/s"
  echo "plateaus:        $PLATEAUS"
  echo "ramp_s:          $RAMP_S"
  echo "hold_s:          $HOLD_S"
} | tee "$RESULTS_DIR/run-context.txt"

# ------------------------------------------------------------ start server ---

SERVER_PID=""
SAMPLER_PID=""

cleanup() {
  if [ -n "$SAMPLER_PID" ] && kill -0 "$SAMPLER_PID" 2>/dev/null; then
    kill "$SAMPLER_PID" 2>/dev/null || true
  fi
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "==> stopping server (pid $SERVER_PID)"
    kill "$SERVER_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.25
    done
    kill -9 "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "==> starting server on port $PORT (mode=$MODE)"
(
  cd "$APP_DIR"
  if [ -n "$ARCJET_ENABLED_VAL" ]; then
    export ARCJET_ENABLED="$ARCJET_ENABLED_VAL"
  fi
  export ARCJET_MODE="$ARCJET_MODE_VAL"
  export APMINSIGHT_AGENT_DISABLE="$APM_DISABLE_VAL"
  export PORT="$PORT"
  exec node index.js
) > "$RESULTS_DIR/server-stdout.txt" 2>&1 &
SERVER_PID=$!

echo "==> server pid $SERVER_PID, waiting for it to accept requests"
READY=""
for _ in $(seq 1 120); do
  if curl -fsS -o /dev/null "$BASE_URL/" 2>/dev/null; then READY=yes; break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "server exited during startup:" >&2
    cat "$RESULTS_DIR/server-stdout.txt" >&2
    exit 1
  fi
  sleep 0.5
done
[ -n "$READY" ] || { echo "server did not become ready in 60s" >&2; cat "$RESULTS_DIR/server-stdout.txt" >&2; exit 1; }

# Confirm from the log that the flags actually took effect, rather than
# trusting that exporting them was enough.
echo "==> server boot flags:"
grep -Ei "arcjet|\[APM\]" "$RESULTS_DIR/server-stdout.txt" | sed 's/^/    /' || echo "    (none logged)"

# ----------------------------------------------------------- start sampler ---

"$SCRIPT_DIR/sample-server.sh" "$SERVER_PID" "$PORT" "$RESULTS_DIR/samples.csv" &
SAMPLER_PID=$!
echo "==> sampler pid $SAMPLER_PID -> samples.csv"

# ------------------------------------------------------------------- run k6 ---

echo "==> running k6"
set +e
BASE_URL="$BASE_URL" \
MATCH_COUNT="$MATCH_COUNT" \
PUBLISH_RATE="$PUBLISH_RATE" \
PLATEAUS="$PLATEAUS" \
RAMP_S="$RAMP_S" \
HOLD_S="$HOLD_S" \
k6 run \
  --summary-export "$RESULTS_DIR/summary.json" \
  "$SCRIPT_DIR/baseline.js" 2>&1 | tee "$RESULTS_DIR/k6-stdout.txt"
K6_EXIT="${PIPESTATUS[0]}"
set -e

# 99 means a threshold was crossed. The thresholds here are deliberately loose
# and exist mainly to force the per-plateau rows into the summary, so a 99 is
# information, not a broken run.
echo "==> k6 exit code $K6_EXIT"

kill "$SAMPLER_PID" 2>/dev/null || true
SAMPLER_PID=""

# --------------------------------------------------------------- teardown ----

cleanup
SERVER_PID=""
SAMPLER_PID=""

# ----------------------------------------------------------------- report ----

echo "==> building report"
python3 "$SCRIPT_DIR/report.py" "$RESULTS_DIR" || echo "report generation failed (raw output is still in $RESULTS_DIR)"

echo
echo "==> done. raw output kept in:"
echo "    $RESULTS_DIR"
ls -1 "$RESULTS_DIR" | sed 's/^/      /'
