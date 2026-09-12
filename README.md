# Live sports feed

A real-time sports commentary service. Clients subscribe to a match over
WebSocket and receive every event for it the moment it is written — goals,
cards, substitutions, whatever the sport calls for — with the write path,
fan-out cost and failure modes all measured rather than assumed.

Built to learn backend engineering properly: every design decision in the code
has a comment saying *why*, and every performance claim below has a load-test
run behind it.

## How it works

```
                 ┌──────────────────────────────────────────────┐
  HTTP  ───────▶ │  Express 5                                    │
                 │   express.json → Arcjet rate limit → routers  │
                 │                                               │
                 │   POST /matches ──────────┐                   │
                 │   POST /matches/:id/commentary ─┐             │
                 │                           │     │             │
                 │             Zod validate ─┴─────┴─▶ Drizzle ──┼──▶ Neon Postgres
                 │                                   │           │
                 │                              broadcast        │
                 │                                   │           │
  WS  ─────────▶ │  ws  (/ws, same HTTP server)      ▼           │
   subscribe ──▶ │   matchSubscribers: Map<matchId, Set<socket>> │
   ◀── events    │   heartbeat reaps dead sockets every 30s      │
                 └──────────────────────────────────────────────┘
```

- **One HTTP server, two protocols.** Express and `ws` share a single
  `http.Server`, so a WebSocket upgrade hits the same rate limiter as an HTTP
  request.
- **Writes go to Postgres first, then broadcast.** The route responds `201`
  once the row is committed; the broadcast happens after, inside its own
  try/catch, so a notification failure can never turn a successful write into
  a `500`.
- **Fan-out is scoped.** A new match is announced to every socket; commentary
  goes only to sockets that subscribed to that match.
- **The database enforces the invariants.** Match status is a native PG enum,
  `(match_id, sequence)` is a unique index, and commentary cascades on match
  delete. Constraint violations are mapped to `404` / `409` instead of leaking
  as `500`s.

## Stack

| Concern | Choice | Why |
|---|---|---|
| HTTP | [Express 5](https://expressjs.com) | Async handlers forward errors without wrappers |
| WebSocket | [`ws`](https://github.com/websockets/ws) | Bare protocol, no framework magic |
| Database | [Neon](https://neon.tech) Postgres via [Drizzle ORM](https://orm.drizzle.team) | Serverless PG; typed schema in plain JS |
| Validation | [Zod 4](https://zod.dev) | Validate at the boundary, coerce only where input is genuinely a string |
| Rate limiting | [Arcjet](https://arcjet.com) | Sliding window on both HTTP and WS upgrades |
| Tests | `node:test` | No test framework dependency |
| Load tests | [k6](https://k6.io) | Measured baseline before any scaling work |

Plain JavaScript (ESM), Node 24.

## Getting started

Everything lives under `src/` — `package.json`, `node_modules`, `.env`. Run
every command from there.

```bash
cd src
npm install
cp .env.example .env        # fill in DATABASE_URL at minimum
npm run db:migrate           # applies drizzle/ migrations to Neon
npm run dev                  # node --watch index.js, on http://localhost:8000
```

Arcjet and the APM agent are optional. Leave `ARCJET_KEY` empty for local
work; set `ARCJET_ENABLED=false` to take it out of the request path entirely.
`.env.example` documents every variable, including two flags whose semantics
are not what you'd guess.

## API

### HTTP

| Method | Path | Body / query | Responds |
|---|---|---|---|
| `GET` | `/matches` | `?limit=1..100` (default 50) | `200 { matches: [...] }` |
| `POST` | `/matches` | `{ sport, homeTeam, awayTeam, startTime, endTime?, homeScore?, awayScore? }` | `201 { match }` — status derived from `startTime`/`endTime` |
| `GET` | `/matches/:id/commentary` | `?limit=1..100` (default 100) | `200 { commentary: [...] }` newest first, ordered by `sequence` |
| `POST` | `/matches/:id/commentary` | `{ sequence, eventType, message, minute?, period?, actor?, team?, metadata?, tags? }` | `201 { commentary }` |

Errors are uniform: `400 { error, details: [{ field, message }] }` for
validation, `404` for an unknown match, `409` for a duplicate `sequence`, `429`
when rate limited, and `500 { error }` with a generic message — Postgres error
text never reaches the client.

```bash
curl -X POST localhost:8000/matches -H 'content-type: application/json' -d '{
  "sport": "football", "homeTeam": "Arsenal", "awayTeam": "Spurs",
  "startTime": "2026-09-13T15:00:00Z"
}'

curl -X POST localhost:8000/matches/1/commentary -H 'content-type: application/json' -d '{
  "sequence": 1, "minute": 23, "period": "1H", "eventType": "goal",
  "actor": "Saka", "team": "Arsenal", "message": "Saka curls it in from the edge of the box"
}'
```

### WebSocket

Connect to `ws://localhost:8000/ws`. All frames are JSON.

| Client sends | Server replies |
|---|---|
| *(on connect)* | `{ type: "welcome" }` |
| `{ type: "subscribe", matchId }` | `{ type: "subscribed", matchId }` |
| `{ type: "unsubscribe", matchId }` | `{ type: "unsubscribed", matchId }` |
| anything else | `{ type: "error", error }` |

| Server pushes | To whom |
|---|---|
| `{ type: "matchCreated", data }` | every connected socket |
| `{ type: "commentaryCreated", data }` | subscribers of `data.matchId` only |

Limits: 50 subscriptions per socket, 1 MiB max frame, 30 s heartbeat.
Messages sent before the connection's security check resolves are queued (up
to 20) and replayed, so a `subscribe` sent immediately on open is not lost.

```js
const ws = new WebSocket('ws://localhost:8000/ws');
ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', matchId: 1 }));
ws.onmessage = (e) => console.log(JSON.parse(e.data));
```

## Measured performance

Single Node process, one Neon database, Arcjet and APM out of the path. Full
method, raw output and analysis in [`load-tests/`](load-tests/PHASE1-FINDINGS.md).

**500 concurrent subscribers across 5 matches, 20 writes/s, 4 min 10 s:**

| | p50 | p95 | p99 |
|---|---|---|---|
| End-to-end (POST sent → frame received) | 102 ms | 179 ms | 350 ms |
| HTTP write alone | 100.5 ms | | |
| **Fan-out to 500 sockets** | **1.5 ms** | | |

- 0 of 5,001 writes failed; 179,877 of 180,000 expected frames (99.93%)
  delivered inside the measured window
- Peak CPU 11% of one core; memory flat at 327 MB
- Fan-out cost scales with subscribers *per match*, not total: ~1 ms per 100
  on one match, so spreading load across matches is already an effective lever

The conclusion that shapes the roadmap: **the Postgres write is the latency;
fan-out is a rounding error.** Redis pub/sub, when it comes, is a correctness
fix for running more than one instance, not a speed-up — and the numbers above
are what it has to *not* regress.

Arcjet costs a flat ~60 ms per request and ~8.5× the server CPU in `DRY_RUN`.
Worth knowing; not worth removing.

Generator and server shared one machine over loopback, so these are a floor,
not a production prediction.

## Testing

```bash
cd src
npm test
```

23 tests: the match-status state machine, and five WebSocket regression tests
that hold the connection's async security check open to reproduce a crash and a
subscriber leak that only occurred inside that window. The Arcjet client is
injectable (`attachWebSocketServer(server, { arcjet })`) for exactly that
reason — the bugs were unreproducible until the dependency became a parameter.

Load tests are separate and need [k6](https://k6.io):

```bash
cd load-tests
./run-baseline.sh
```

## Layout

```
src/
  index.js            wires Express + ws onto one http.Server
  routes/             matches.js, commentary.js — validate → insert → broadcast
  validation/         Zod schemas; errors.js maps issues to {field, message}
  ws/
    server.js         subscriptions, broadcast, heartbeat, pre-auth queue
    arcjet.js         rate-limit clients for HTTP and WS upgrade
  db/
    schema.js         Drizzle tables, enum, indexes
    db.js             pg Pool + drizzle()
  drizzle/            generated migrations
  utils/              match status derivation
load-tests/           k6 scenario, run script, per-run results
```

## Status

Working, tested, measured, not yet deployed. In rough order, what comes next:

1. Route tests + CI
2. Deploy (graceful shutdown first — today a restart drops every connection)
3. Redis pub/sub so the service can run as more than one instance, then re-run
   the identical load test
4. Backpressure for slow clients, and `since=<sequence>` replay on reconnect
5. Ingest real match data from [OpenLigaDB](https://api.openligadb.de),
   idempotently, so re-polling never duplicates an event
