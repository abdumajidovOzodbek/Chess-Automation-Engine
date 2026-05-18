import { createWriteStream, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { randomUUID } from "crypto";
import { createLogger } from "./index.ts";
import { fenToHash } from "../board/index.ts";
import type { BoardState, EngineMove, BoardMove, Color, MoveLogEntry, GameSession } from "../types.ts";

const logger = createLogger("game-logger");

export class GameLogger {
  private session: GameSession | null = null;
  private logDir: string;
  private logStream: ReturnType<typeof createWriteStream> | null = null;
  private moveStartTime = 0;
  private thinkStartTime = 0;

  constructor(logDir: string = "./logs/sessions") {
    this.logDir = logDir;
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
  }

  startSession(url: string, color: Color): GameSession {
    const id = randomUUID();
    this.session = {
      id,
      startedAt: Date.now(),
      url,
      color,
      moves: [],
    };

    const logPath = join(this.logDir, `${id}.ndjson`);
    this.logStream = createWriteStream(logPath, { encoding: "utf8" });

    this.writeEvent("session_start", {
      sessionId: id,
      url,
      color,
      startedAt: this.session.startedAt,
    });

    logger.info({ sessionId: id, url, color, logPath }, "Game session started");
    return { ...this.session };
  }

  markThinkStart(): void {
    this.thinkStartTime = Date.now();
  }

  markMoveStart(): void {
    this.moveStartTime = Date.now();
  }

  recordMove(
    boardState: BoardState,
    move: BoardMove,
    engineMove?: EngineMove,
    source: MoveLogEntry["source"] = "engine"
  ): MoveLogEntry | null {
    if (!this.session) {
      logger.warn("Cannot record move — no active session");
      return null;
    }

    const now = Date.now();
    const entry: MoveLogEntry = {
      id: randomUUID(),
      gameId: this.session.id,
      moveNumber: boardState.moveNumber,
      color: boardState.turn === "w" ? "b" : "w",
      uci: move.uci ?? (move.from + move.to + (move.promotion ?? "")),
      san: move.san ?? "",
      fen: boardState.fen,
      engineMove,
      thinkingTimeMs: this.thinkStartTime > 0 ? now - this.thinkStartTime : 0,
      executionTimeMs: this.moveStartTime > 0 ? now - this.moveStartTime : 0,
      timestamp: now,
      boardStateHash: fenToHash(boardState.fen),
      source,
    };

    this.session.moves.push(entry);
    this.writeEvent("move", entry);

    logger.info({
      move: entry.uci,
      san: entry.san,
      moveNumber: entry.moveNumber,
      thinkingMs: entry.thinkingTimeMs,
      score: engineMove?.score,
    }, "Move recorded");

    this.thinkStartTime = 0;
    this.moveStartTime = 0;

    return entry;
  }

  recordBoardState(state: BoardState): void {
    this.writeEvent("board_state", {
      fen: state.fen,
      turn: state.turn,
      moveNumber: state.moveNumber,
      isCheck: state.isCheck,
      timestamp: Date.now(),
    });
  }

  recordEvent(eventType: string, data: Record<string, unknown>): void {
    this.writeEvent(eventType, { ...data, timestamp: Date.now() });
  }

  endSession(result: GameSession["result"] = "unknown", finalFen?: string): GameSession | null {
    if (!this.session) return null;

    this.session.endedAt = Date.now();
    this.session.result = result;
    this.session.finalFen = finalFen;

    this.writeEvent("session_end", {
      sessionId: this.session.id,
      result,
      finalFen,
      totalMoves: this.session.moves.length,
      durationMs: this.session.endedAt - this.session.startedAt,
    });

    this.logStream?.end();
    this.logStream = null;

    const duration = this.session.endedAt - this.session.startedAt;
    logger.info({
      sessionId: this.session.id,
      result,
      totalMoves: this.session.moves.length,
      durationMs: duration,
    }, "Game session ended");

    const completed = { ...this.session };
    this.session = null;
    return completed;
  }

  getSession(): GameSession | null {
    return this.session ? { ...this.session } : null;
  }

  getMoveHistory(): MoveLogEntry[] {
    return this.session?.moves ?? [];
  }

  getAverageThinkingTime(): number {
    const moves = this.session?.moves ?? [];
    if (!moves.length) return 0;
    return moves.reduce((sum, m) => sum + m.thinkingTimeMs, 0) / moves.length;
  }

  private writeEvent(type: string, data: unknown): void {
    if (!this.logStream?.writable) return;
    const line = JSON.stringify({ type, ...((data as object) ?? {}), _ts: Date.now() });
    this.logStream.write(line + "\n");
  }
}
