export type Color = "w" | "b";
export type PieceType = "p" | "n" | "b" | "r" | "q" | "k";
export type Square =
  | "a1" | "b1" | "c1" | "d1" | "e1" | "f1" | "g1" | "h1"
  | "a2" | "b2" | "c2" | "d2" | "e2" | "f2" | "g2" | "h2"
  | "a3" | "b3" | "c3" | "d3" | "e3" | "f3" | "g3" | "h3"
  | "a4" | "b4" | "c4" | "d4" | "e4" | "f4" | "g4" | "h4"
  | "a5" | "b5" | "c5" | "d5" | "e5" | "f5" | "g5" | "h5"
  | "a6" | "b6" | "c6" | "d6" | "e6" | "f6" | "g6" | "h6"
  | "a7" | "b7" | "c7" | "d7" | "e7" | "f7" | "g7" | "h7"
  | "a8" | "b8" | "c8" | "d8" | "e8" | "f8" | "g8" | "h8";

export interface Piece {
  type: PieceType;
  color: Color;
}

export interface BoardMove {
  from: Square;
  to: Square;
  promotion?: PieceType;
  san?: string;
  uci?: string;
  timestamp: number;
}

export interface BoardState {
  fen: string;
  turn: Color;
  moveNumber: number;
  isCheck: boolean;
  isCheckmate: boolean;
  isStalemate: boolean;
  isDraw: boolean;
  history: BoardMove[];
  extractedAt: number;
}

export interface EngineMove {
  uci: string;
  from: Square;
  to: Square;
  promotion?: PieceType;
  score?: EngineScore;
  depth?: number;
  nodes?: number;
  time?: number;
  pv?: string[];
}

export interface EngineScore {
  type: "cp" | "mate";
  value: number;
}

export interface EngineOptions {
  depth?: number;
  movetime?: number;
  nodes?: number;
  multiPV?: number;
  threads?: number;
  hashMB?: number;
  skillLevel?: number;
}

export interface SessionConfig {
  url: string;
  username?: string;
  password?: string;
  loginSelector?: string;
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
  sessionCookieName?: string;
  headless?: boolean;
  slowMo?: number;
  timeout?: number;
}

export interface BrowserConfig {
  headless?: boolean;
  slowMo?: number;
  timeout?: number;
  userAgent?: string;
  viewport?: { width: number; height: number };
  recordVideo?: boolean;
  recordVideoDir?: string;
  storageStatePath?: string;
}

export interface BoardExtractorConfig {
  boardSelector?: string;
  squareSelector?: string;
  pieceSelector?: string;
  fenAttribute?: string;
  apiEndpoint?: string;
  pollIntervalMs?: number;
}

export interface SyncConfig {
  color: Color;
  autoMove: boolean;
  moveDelayMs?: number;
  moveJitterMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

export interface MoveLogEntry {
  id: string;
  gameId: string;
  moveNumber: number;
  color: Color;
  uci: string;
  san: string;
  fen: string;
  engineMove?: EngineMove;
  thinkingTimeMs: number;
  executionTimeMs: number;
  timestamp: number;
  boardStateHash: string;
  source: "engine" | "human" | "replay";
}

export interface GameSession {
  id: string;
  startedAt: number;
  endedAt?: number;
  url: string;
  color: Color;
  result?: "win" | "loss" | "draw" | "unknown";
  moves: MoveLogEntry[];
  pgn?: string;
  finalFen?: string;
}

export interface ReplayOptions {
  sessionId?: string;
  logFile?: string;
  speedMultiplier?: number;
  startAtMove?: number;
  stopAtMove?: number;
  showEngine?: boolean;
}

export type SyncEvent =
  | { type: "board_detected"; state: BoardState }
  | { type: "move_required"; state: BoardState; color: Color }
  | { type: "engine_move"; move: EngineMove }
  | { type: "move_executed"; move: BoardMove }
  | { type: "move_failed"; move: BoardMove; reason: string }
  | { type: "session_lost"; reason: string }
  | { type: "session_recovered" }
  | { type: "game_over"; result: string };

export type EventHandler<T extends SyncEvent> = (event: T) => void | Promise<void>;
