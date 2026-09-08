/**
 * Phase 1 baseline - single instance, in-process broadcast.
 *
 * The point of this run is to have a "before" number that Phase 2 (Redis
 * pub/sub) can be measured against. It is deliberately taken on the system as
 * it exists today: one node process, one `matchSubscribers` Map in memory,
 * one Neon database.
 *
 * Two scenarios run at the same time against the same server:
 *
 *   subscribers - ramps WebSocket connections through a series of plateaus
 *                 (50 -> 200 -> 500 by default). Each VU opens ONE socket,
 *                 sends {type:'subscribe', matchId}, and then holds that
 *                 socket open for the rest of the test, counting what arrives.
 *
 *   publisher   - fires POST /matches/:id/commentary at a fixed rate for the
 *                 whole run, independent of how many subscribers exist.
 *
 * ---------------------------------------------------------------------------
 * How the end-to-end latency is measured, and why it is done this way
 * ---------------------------------------------------------------------------
 * We want "time from POST to the WS message arriving". The POST happens in a
 * publisher VU and the WS frame arrives in a *different* subscriber VU, and k6
 * VUs have completely isolated JS memory - there is no shared variable to park
 * a start timestamp in.
 *
 * So the timestamp travels inside the payload. The publisher stamps
 * `metadata.postedAt = Date.now()` immediately before sending, the row is
 * persisted with that metadata, `broadcastCommentaryCreated` sends the row
 * back out, and the subscriber computes `Date.now() - postedAt`. Both VUs are
 * in the same k6 process on one machine, so it is the same clock - no skew.
 *
 * This is only sound because both scenarios run on ONE load generator. If this
 * is ever split across machines the clocks must be synchronised or the number
 * is meaningless.
 *
 * ---------------------------------------------------------------------------
 * Why the number is split in two
 * ---------------------------------------------------------------------------
 * `e2e_latency` bundles the HTTP request, Zod, the Neon INSERT round trip, the
 * JSON serialise and the fan-out loop. Neon is a network database, so the
 * INSERT is likely to dominate - which would mask any fan-out improvement in
 * Phase 2 behind a constant that Redis cannot change.
 *
 * `post_duration` is recorded separately from the publisher side: it is the
 * HTTP request on its own. Because the route responds *before* it broadcasts
 * (routes/commentary.js:75-81), the difference between the two percentiles is
 * roughly the fan-out cost - and that is the part Phase 2 actually moves.
 *
 * ---------------------------------------------------------------------------
 * Why every sample is tagged with a phase
 * ---------------------------------------------------------------------------
 * A single p99 over the whole run would blend the 50-connection regime with
 * the 500-connection regime and describe neither. Each sample is tagged with
 * the plateau it landed in, and thresholds are declared per plateau so they
 * appear as separate rows in the summary. Samples taken during a ramp are
 * tagged `ramp` and should be ignored - the connection count is moving.
 */
import { sleep } from 'k6';
import http from 'k6/http';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';
import { WebSocket } from 'k6/websockets';

// ---------------------------------------------------------------- config ---

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8000';
const WS_URL = BASE_URL.replace(/^http/, 'ws') + '/ws';

// One match by default. All subscribers watch it and all commentary goes to
// it, so fan-out per event == subscriber count - the maximum-signal version of
// the experiment, and the one Phase 2 is meant to change. Raise MATCH_COUNT
// for a more realistic spread, at the cost of a weaker signal.
const MATCH_COUNT = Number(__ENV.MATCH_COUNT || 1);

// Publishes per second, held constant regardless of subscriber count.
const PUBLISH_RATE = Number(__ENV.PUBLISH_RATE || 10);

const PLATEAUS = (__ENV.PLATEAUS || '50,200,500')
  .split(',')
  .map((n) => Number(n.trim()))
  .filter((n) => n > 0);

const RAMP_S = Number(__ENV.RAMP_S || 30);
const HOLD_S = Number(__ENV.HOLD_S || 60);
const RAMPDOWN_S = 10;

// Each publisher VU owns a block of the sequence space. The database has a
// unique index on (match_id, sequence), so two publishers picking the same
// number would collide with a 23505 -> 409. Stride 100k with a few hundred VUs
// stays far below PG int4 max (2,147,483,647).
const SEQ_STRIDE = 100_000;

// Build the stage list and the plateau time-windows from the same numbers, so
// they can never drift apart.
const stages = [];
const phases = [];
let elapsed = 0;
for (const target of PLATEAUS) {
  stages.push({ duration: `${RAMP_S}s`, target });
  elapsed += RAMP_S;
  const startMs = elapsed * 1000;
  stages.push({ duration: `${HOLD_S}s`, target });
  elapsed += HOLD_S;
  phases.push({ name: String(target), startMs, endMs: elapsed * 1000 });
}
stages.push({ duration: `${RAMPDOWN_S}s`, target: 0 });

const TOTAL_S = elapsed + RAMPDOWN_S;
const TOTAL_MS = TOTAL_S * 1000;

const thresholds = {
  // A baseline should not "fail"; these are deliberately loose. They exist to
  // force the tagged sub-metrics into the summary output, which k6 only emits
  // for metrics that carry a threshold.
  publish_success_rate: ['rate>0.95'],
  e2e_latency: ['p(99)<30000'],
};
for (const phase of phases) {
  thresholds[`e2e_latency{phase:${phase.name}}`] = ['p(99)<30000'];
  thresholds[`post_duration{phase:${phase.name}}`] = ['p(99)<30000'];
}

export const options = {
  scenarios: {
    subscribers: {
      executor: 'ramping-vus',
      exec: 'subscriber',
      startVUs: 0,
      stages,
      // Iterations here are long-lived by design (one held socket each), so
      // there is nothing to gain by waiting for them to finish on ramp-down.
      gracefulRampDown: '5s',
    },
    publisher: {
      executor: 'constant-arrival-rate',
      exec: 'publisher',
      rate: PUBLISH_RATE,
      timeUnit: '1s',
      duration: `${TOTAL_S}s`,
      // An OPEN model: it fires at a fixed rate whether or not the server is
      // keeping up. A closed model (constant-vus) would quietly slow its own
      // request rate when the server slowed down, hiding the very problem the
      // test is looking for.
      preAllocatedVUs: Math.max(10, PUBLISH_RATE * 2),
      maxVUs: Math.max(50, PUBLISH_RATE * 20),
    },
  },
  thresholds,
  summaryTrendStats: ['min', 'avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
};

// --------------------------------------------------------------- metrics ---

const e2eLatency = new Trend('e2e_latency', true);
const postDuration = new Trend('post_duration', true);

const wsConnected = new Counter('ws_connected');
const wsSubscribeAcks = new Counter('ws_subscribe_acks');
const wsErrors = new Counter('ws_errors');
const wsProtocolErrors = new Counter('ws_protocol_errors');
const commentaryReceived = new Counter('commentary_received');
const staleTimestamps = new Counter('commentary_without_timestamp');

const publishOk = new Counter('publish_ok');
const publishFail = new Counter('publish_fail');
const publishConflict = new Counter('publish_seq_conflict_409');
const publishRateLimited = new Counter('publish_rate_limited_429');
const publishSuccessRate = new Rate('publish_success_rate');

const JSON_HEADERS = { headers: { 'Content-Type': 'application/json' } };

/**
 * Which plateau are we in right now? Anything during a ramp is tagged `ramp`
 * and excluded from the per-plateau rows, because the connection count is
 * still moving and the sample cannot be attributed to a level.
 */
function currentPhase() {
  const ms = exec.instance.currentTestRunDuration;
  for (const phase of phases) {
    if (ms >= phase.startMs && ms < phase.endMs) return phase.name;
  }
  return 'ramp';
}

// ----------------------------------------------------------------- setup ---

export function setup() {
  // Neon suspends an idle compute, so the first query of the run can take
  // seconds. Absorb that here rather than in the measured window.
  const warm = http.get(`${BASE_URL}/matches?limit=1`);
  if (warm.status !== 200) {
    throw new Error(`server not healthy: GET /matches -> ${warm.status} ${warm.body}`);
  }

  // Fresh matches every run. That keeps each run's sequence space empty, so a
  // re-run can never collide with rows left by the previous one, and it makes
  // the test data trivial to identify and delete (sport = 'loadtest').
  const now = Date.now();
  const matchIds = [];
  for (let i = 0; i < MATCH_COUNT; i += 1) {
    const body = JSON.stringify({
      sport: 'loadtest',
      homeTeam: `LoadTest Home ${i}`,
      awayTeam: `LoadTest Away ${i}`,
      // Started an hour ago, ends in three: getMatchStatus resolves this to
      // 'live', which is the state a real commentary feed runs in.
      startTime: new Date(now - 3600 * 1000).toISOString(),
      endTime: new Date(now + 3 * 3600 * 1000).toISOString(),
    });
    const res = http.post(`${BASE_URL}/matches`, body, JSON_HEADERS);
    if (res.status !== 201) {
      throw new Error(`setup could not create match: ${res.status} ${res.body}`);
    }
    matchIds.push(res.json('match.id'));
  }

  console.log(
    `setup: ${matchIds.length} match(es) created -> [${matchIds.join(', ')}]; ` +
      `plateaus [${PLATEAUS.join(', ')}], publish ${PUBLISH_RATE}/s, total ${TOTAL_S}s`,
  );
  return { matchIds };
}

// ------------------------------------------------------------ subscriber ---

export function subscriber(data) {
  const matchId = data.matchIds[(exec.vu.idInTest - 1) % data.matchIds.length];

  // Hold the socket until the end of the test, whenever this VU happened to
  // start. A VU that joins during the 500 ramp still contributes to the 500
  // plateau, which is the whole point of holding rather than reconnecting.
  const remainingMs = TOTAL_MS - exec.instance.currentTestRunDuration;

  // Do not open a socket that would immediately have to close again. A VU
  // recycled in the last seconds of the run would otherwise inflate
  // ws_connected with a connection that never sat in any plateau - the smoke
  // run showed 7 connections for 5 VUs this way.
  //
  // sleep() rather than return, and never sleep zero. Returning ends the
  // iteration instantly and ramping-vus starts another one straight away, so
  // 500 VUs spin hot for the last seconds of the run - the first two recorded
  // runs logged 182k and 253k no-op iterations against ~3.3k real ones.
  //
  // Clamping the sleep at 0 does not fix it: once the run is past its nominal
  // end, remainingMs is negative, sleep(0) returns immediately and the spin
  // continues (measured: 14,963 iterations in the final 0.3s). The floor has
  // to be non-zero. k6 interrupts the parked VU at ramp-down anyway.
  if (remainingMs < 5000) {
    sleep(Math.max(remainingMs / 1000, 1));
    return;
  }

  const holdMs = remainingMs - 500;

  const socket = new WebSocket(WS_URL);

  socket.onopen = () => {
    wsConnected.add(1);
    socket.send(JSON.stringify({ type: 'subscribe', matchId }));
  };

  socket.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (err) {
      wsProtocolErrors.add(1);
      return;
    }

    switch (message.type) {
      case 'welcome':
        return;

      case 'subscribed':
        wsSubscribeAcks.add(1);
        return;

      case 'commentaryCreated': {
        commentaryReceived.add(1);
        const postedAt =
          message.data && message.data.metadata && message.data.metadata.postedAt;
        if (typeof postedAt === 'number') {
          e2eLatency.add(Date.now() - postedAt, { phase: currentPhase() });
        } else {
          // Would mean the metadata round trip broke - the latency number
          // depends entirely on it, so count rather than silently skip.
          staleTimestamps.add(1);
        }
        return;
      }

      case 'matchCreated':
        // Broadcast to every socket, not just subscribers. Matches are only
        // created in setup(), before anyone connects, so this should not fire.
        return;

      case 'error':
        wsProtocolErrors.add(1);
        return;

      default:
        wsProtocolErrors.add(1);
    }
  };

  socket.onerror = () => {
    wsErrors.add(1);
  };

  // Returning here does not end the iteration: k6 keeps it alive while the
  // socket and this timer are still pending on the event loop. That is what
  // makes one VU hold one connection for the duration.
  setTimeout(() => {
    socket.close();
  }, holdMs);
}

// ------------------------------------------------------------- publisher ---

export function publisher(data) {
  const matchId =
    data.matchIds[
      (exec.vu.idInTest + exec.vu.iterationInInstance) % data.matchIds.length
    ];

  const sequence = exec.vu.idInTest * SEQ_STRIDE + exec.vu.iterationInInstance;

  // Stamped as late as possible before the request leaves, so the measured
  // interval is POST -> WS receive and not "some time earlier -> WS receive".
  const postedAt = Date.now();

  const res = http.post(
    `${BASE_URL}/matches/${matchId}/commentary`,
    JSON.stringify({
      sequence,
      minute: exec.vu.iterationInInstance % 120,
      period: '1H',
      eventType: 'loadtest',
      message: `load-test commentary seq=${sequence}`,
      metadata: { postedAt },
    }),
    JSON_HEADERS,
  );

  const ok = res.status === 201;
  publishSuccessRate.add(ok);

  if (ok) {
    publishOk.add(1);
    postDuration.add(res.timings.duration, { phase: currentPhase() });
    return;
  }

  publishFail.add(1);
  if (res.status === 409) {
    // Two publishers claimed the same (match_id, sequence). Should be
    // impossible given SEQ_STRIDE; if this is non-zero the stride is wrong.
    publishConflict.add(1);
  } else if (res.status === 429) {
    // Arcjet is still in the path. The baseline is invalid if this is non-zero
    // - see load-tests/README.md.
    publishRateLimited.add(1);
  }
}
