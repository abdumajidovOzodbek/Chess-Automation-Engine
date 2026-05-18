# Chess Research Framework

A modular Node.js framework for browser-automated chess research in **authorized and controlled environments only**. Integrates Playwright for browser automation with Stockfish for engine-based move generation, board-state extraction, and session management.

---

## Architecture

```
src/
├── types.ts                     Shared TypeScript interfaces
├── index.ts                     Public API exports
├── session-facade.ts            High-level ChessResearchSession orchestrator
│
├── automation/
│   ├── browser.ts               Playwright BrowserManager (launch, pages, screenshots, storage state)
│   └── session.ts               SessionManager (auth flows, session recovery, activity tracking)
│
├── board/
│   ├── extractor.ts             BoardExtractor (FEN from DOM/attributes/API, move execution, polling)
│   ├── state.ts                 Board state model (FEN parsing, move application, PGN, diff)
│   └── validator.ts             Move legality, FEN validation, game-over detection
│
├── engine/
│   ├── stockfish.ts             StockfishEngine (UCI process manager, async getBestMove, EventEmitter)
│   └── uci.ts                   UCI protocol parser/serializer (info lines, options, go command)
│
├── sync/
│   └── synchronizer.ts          GameSynchronizer (board polling → engine → move execution loop)
│
├── logger/
│   ├── index.ts                 Pino logger factory
│   ├── game-logger.ts           Structured NDJSON session logger (moves, timing, events)
│   └── replay.ts                ReplayTool (load sessions, replay, timing analysis, PGN export)
│
└── cli/
    └── run.ts                   CLI entry point (run / analyze / replay / sessions commands)
```

---

## CLI Commands

### Run an automated session

```bash
pnpm run:cli run \
  --url https://your-authorized-chess-platform.example.com \
  --color w \
  --username myuser \
  --password mypass \
  --depth 18 \
  --movetime 3000 \
  --delay 300 \
  --jitter 400 \
  --log-dir ./logs/sessions
```

| Flag | Default | Description |
|---|---|---|
| `--url` | required | Target platform URL |
| `--color` | `w` | Your piece color (`w` or `b`) |
| `--username` / `--password` | — | Login credentials |
| `--headless` | `false` | Run browser headlessly |
| `--depth` | `18` | Stockfish search depth |
| `--movetime` | `3000` | Max engine think time (ms) |
| `--delay` | `300` | Base delay before move execution (ms) |
| `--jitter` | `400` | Random jitter added to delay (ms) |
| `--slow-mo` | `0` | Playwright action slow-down (ms) |
| `--log-dir` | `./logs/sessions` | Session log directory |
| `--save-state` | — | Save browser cookies/storage after session |
| `--load-state` | — | Load previously saved browser state |

### Analyze a position

```bash
pnpm run:cli analyze \
  --fen "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1" \
  --depth 20 \
  --multipv 3
```

### Replay a recorded session

```bash
# List all sessions
pnpm run:cli sessions

# Replay at 2× speed with engine info
pnpm run:cli replay --session-id <uuid> --speed 2 --show-engine

# Export PGN
pnpm run:cli replay --session-id <uuid> --export-pgn > game.pgn
```

---

## Programmatic API

```typescript
import { ChessResearchSession } from "@workspace/chess-research";

const session = new ChessResearchSession({
  session: {
    url: "https://your-chess-platform.example.com/game/123",
    username: "authorized_user",
    password: "secret",
  },
  browser: { headless: false, slowMo: 50 },
  sync: { color: "w", autoMove: true, moveDelayMs: 400, moveJitterMs: 300 },
  engine: { depth: 18, movetime: 3000, threads: 2, hashMB: 128 },
  logDir: "./logs/sessions",
});

await session.start();
const result = await session.waitForGameEnd();
console.log("Game result:", result);
await session.shutdown();
```

### Using components individually

```typescript
import {
  BrowserManager,
  SessionManager,
  BoardExtractor,
  StockfishEngine,
  GameSynchronizer,
  GameLogger,
  ReplayTool,
} from "@workspace/chess-research";

// Engine-only analysis
const engine = new StockfishEngine();
await engine.start();
engine.configure({ depth: 20, multiPV: 3, threads: 4, hashMB: 256 });

const move = await engine.getBestMove(
  "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
  { movetime: 5000 }
);
console.log("Best move:", move?.uci, "Score:", move?.score);
await engine.close();

// Board state utilities
import { parseFen, validateMove, getLegalMoves, movesToPgn } from "@workspace/chess-research";

const state = parseFen("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1");
const legal = getLegalMoves(state);
const check = validateMove(state, "e7e5");
console.log("e7e5 legal:", check.valid);
```

---

## Board Extraction Strategy

The `BoardExtractor` tries three methods in order:

1. **FEN attribute** — looks for `[data-fen]`, `[fen]`, or custom attribute on the board element
2. **API endpoint** — fetches a JSON endpoint (if configured) and parses the `fen` / `position` field
3. **DOM analysis** — scans piece elements for `square-XY` CSS classes (chess.com / lichess style) and reconstructs the FEN

Configure extraction for your target platform:

```typescript
const extractor = new BoardExtractor({
  boardSelector: "chess-board",       // main board container
  squareSelector: "[data-square]",    // individual square elements
  pieceSelector: "piece",             // piece elements with class-encoded type
  fenAttribute: "data-fen",           // attribute holding FEN directly
  apiEndpoint: "/api/game/state",     // optional: JSON endpoint for board state
  pollIntervalMs: 500,                // polling frequency
});
```

---

## Session Logs

Every game session is stored as a newline-delimited JSON (`.ndjson`) file:

```jsonc
{"type":"session_start","sessionId":"...","url":"...","color":"w","_ts":1716000000000}
{"type":"board_state","fen":"rnbq...","turn":"w","moveNumber":1,"_ts":...}
{"type":"move","uci":"e2e4","san":"e4","thinkingTimeMs":1230,"executionTimeMs":85,"_ts":...}
{"type":"session_end","result":"win","totalMoves":40,"durationMs":3720000,"_ts":...}
```

Each move entry includes:
- `uci` and `san` notation
- `thinkingTimeMs` — how long Stockfish evaluated
- `executionTimeMs` — how long the click took to register
- `engineMove` — full engine analysis (score, depth, pv, nodes)
- `boardStateHash` — position fingerprint (position + turn + castling + en passant)

---

## Legal & Ethical Notice

This framework is built **exclusively for**:
- Authorized anti-cheat system evaluation (with platform permission)
- Controlled research environments and private test servers
- Educational study of chess engine behavior and detection signals

**Do not use this on any platform without explicit written authorization.** Unauthorized automation violates platform Terms of Service and may be illegal in some jurisdictions.
