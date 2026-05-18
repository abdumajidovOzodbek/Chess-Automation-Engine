# Chess Research Framework

A modular Node.js framework for browser-automated chess research in authorized and controlled environments. Combines Playwright browser automation with Stockfish engine integration for board-state extraction, move generation, session management, and gameplay replay analysis.

## Run & Operate

- `pnpm --filter @workspace/chess-research run:cli run --url <url> --color w` — start an automated session
- `pnpm --filter @workspace/chess-research run:cli analyze --fen "<fen>"` — analyze a FEN position
- `pnpm --filter @workspace/chess-research run:cli replay --session-id <id>` — replay a recorded session
- `pnpm --filter @workspace/chess-research run:cli sessions` — list all recorded sessions
- `pnpm --filter @workspace/chess-research run typecheck` — typecheck the framework
- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Browser automation: Playwright (Chromium)
- Chess engine: Stockfish (UCI protocol, child_process spawn)
- Move validation: chess.js
- Logging: Pino + NDJSON session logs
- CLI: Commander.js
- API: Express 5 (api-server artifact)

## Where things live

- `artifacts/chess-research/src/types.ts` — all shared TypeScript interfaces
- `artifacts/chess-research/src/session-facade.ts` — high-level `ChessResearchSession` orchestrator
- `artifacts/chess-research/src/automation/` — BrowserManager + SessionManager
- `artifacts/chess-research/src/board/` — BoardExtractor, state model, move validator
- `artifacts/chess-research/src/engine/` — StockfishEngine + UCI protocol parser
- `artifacts/chess-research/src/sync/` — GameSynchronizer (board ↔ engine loop)
- `artifacts/chess-research/src/logger/` — GameLogger (NDJSON) + ReplayTool
- `artifacts/chess-research/src/cli/run.ts` — CLI entry point
- `artifacts/chess-research/logs/sessions/` — session NDJSON files (created at runtime)
- `artifacts/chess-research/README.md` — full usage documentation

## Architecture decisions

- **UCI via child_process**: Stockfish is spawned as a subprocess and communicated with via stdin/stdout using the UCI protocol. Falls back to the `stockfish` npm package if the system binary is not found.
- **Three-tier board extraction**: FEN attribute → API endpoint → DOM class analysis (in that order), allowing the framework to work against different chess platform implementations.
- **NDJSON session logs**: Each game session is a separate `.ndjson` file with every event (moves, board states, errors, recovery events) timestamped — enabling timing analysis and detection signal research.
- **Move delay + jitter**: All engine moves include a configurable base delay plus random jitter before execution to mimic human timing patterns in test environments.
- **EventEmitter-based sync**: `GameSynchronizer` emits typed `SyncEvent` objects so callers can hook into every phase of the game loop without coupling to internals.

## Product

The framework provides:
1. **Automated chess play** — logs in to a target platform, detects board state via DOM/API, asks Stockfish for moves, and executes them
2. **Position analysis** — analyze any FEN to arbitrary depth with multi-PV output
3. **Session recording** — every move, score, thinking time, and board state logged to NDJSON
4. **Replay and timing analysis** — replay recorded games, export PGN, inspect per-move timing distributions

## User preferences

_Populate as you build._

## Gotchas

- **Always run typecheck after editing**: `pnpm --filter @workspace/chess-research run typecheck`
- **Stockfish binary**: the engine module first tries the system `stockfish` binary via `which`, then falls back to the `stockfish` npm package. Install `stockfish` system package for best performance.
- **Board extraction is platform-specific**: configure `boardSelector`, `pieceSelector`, and `fenAttribute` for your target platform. Chess.com uses `square-XY` CSS classes; lichess uses `cg-board` + `piece` elements.
- **DOM lib in tsconfig**: the board extractor runs code inside `page.evaluate()` (browser context) so the tsconfig includes `"dom"` and `"dom.iterable"` — this is intentional.

## Pointers

- See `artifacts/chess-research/README.md` for full CLI reference and code examples
- See the `pnpm-workspace` skill for workspace structure and package details
