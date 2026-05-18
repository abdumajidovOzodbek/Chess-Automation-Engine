import { createReadStream, existsSync, readdirSync } from "fs";
import { join } from "path";
import { createInterface } from "readline";
import { createLogger } from "./index.ts";
import { parseFen, movesToPgn } from "../board/index.ts";
import type { MoveLogEntry, GameSession, ReplayOptions, BoardState } from "../types.ts";

const logger = createLogger("replay");

interface LogEvent {
  type: string;
  _ts: number;
  [key: string]: unknown;
}

export class ReplayTool {
  private logDir: string;

  constructor(logDir: string = "./logs/sessions") {
    this.logDir = logDir;
  }

  async loadSession(sessionId: string): Promise<GameSession | null> {
    const logPath = join(this.logDir, `${sessionId}.ndjson`);
    if (!existsSync(logPath)) {
      logger.warn({ sessionId, logPath }, "Session log not found");
      return null;
    }

    const events = await this.readNdjson(logPath);
    return this.reconstructSession(events);
  }

  async listSessions(): Promise<Array<{ id: string; startedAt: number; moves: number; result: string }>> {
    if (!existsSync(this.logDir)) return [];

    const files = readdirSync(this.logDir).filter((f) => f.endsWith(".ndjson"));
    const summaries = [];

    for (const file of files) {
      try {
        const events = await this.readNdjson(join(this.logDir, file));
        const startEvt = events.find((e) => e.type === "session_start");
        const endEvt = events.find((e) => e.type === "session_end");
        const moves = events.filter((e) => e.type === "move");

        summaries.push({
          id: file.replace(".ndjson", ""),
          startedAt: (startEvt?._ts ?? 0) as number,
          moves: moves.length,
          result: (endEvt?.["result"] as string) ?? "unknown",
        });
      } catch { /* skip corrupt files */ }
    }

    return summaries.sort((a, b) => b.startedAt - a.startedAt);
  }

  async replay(
    options: ReplayOptions,
    onMove: (entry: MoveLogEntry, state: BoardState, index: number, total: number) => Promise<void>
  ): Promise<void> {
    let session: GameSession | null = null;

    if (options.sessionId) {
      session = await this.loadSession(options.sessionId);
    } else if (options.logFile) {
      const events = await this.readNdjson(options.logFile);
      session = this.reconstructSession(events);
    }

    if (!session) {
      logger.error("No session loaded for replay");
      return;
    }

    const moves = session.moves.slice(
      (options.startAtMove ?? 1) - 1,
      options.stopAtMove
    );

    logger.info({
      sessionId: session.id,
      totalMoves: moves.length,
      speedMultiplier: options.speedMultiplier ?? 1,
    }, "Starting replay");

    for (let i = 0; i < moves.length; i++) {
      const entry = moves[i]!;
      const state = parseFen(entry.fen);

      if (options.showEngine && entry.engineMove) {
        logger.info({
          move: entry.uci,
          san: entry.san,
          score: entry.engineMove.score,
          depth: entry.engineMove.depth,
          thinkingMs: entry.thinkingTimeMs,
        }, `Replay move ${i + 1}/${moves.length}`);
      } else {
        logger.info({
          move: entry.uci,
          san: entry.san,
          moveNumber: entry.moveNumber,
        }, `Replay move ${i + 1}/${moves.length}`);
      }

      await onMove(entry, state, i, moves.length);

      if (i < moves.length - 1 && entry.thinkingTimeMs > 0) {
        const delay = entry.thinkingTimeMs / (options.speedMultiplier ?? 1);
        await sleep(Math.min(delay, 30_000));
      }
    }

    logger.info({ sessionId: session.id }, "Replay complete");
  }

  printTimingAnalysis(session: GameSession): void {
    const moves = session.moves;
    if (!moves.length) {
      logger.info("No moves to analyze");
      return;
    }

    const thinkTimes = moves.map((m) => m.thinkingTimeMs).filter((t) => t > 0);
    const execTimes = moves.map((m) => m.executionTimeMs).filter((t) => t > 0);

    const stats = (arr: number[]) => {
      if (!arr.length) return null;
      const sorted = [...arr].sort((a, b) => a - b);
      return {
        min: sorted[0],
        max: sorted[sorted.length - 1],
        mean: Math.round(arr.reduce((s, v) => s + v, 0) / arr.length),
        median: sorted[Math.floor(sorted.length / 2)],
        p95: sorted[Math.floor(sorted.length * 0.95)],
      };
    };

    logger.info({
      sessionId: session.id,
      totalMoves: moves.length,
      thinkingStats: stats(thinkTimes),
      executionStats: stats(execTimes),
      averageThinkingMs: Math.round(thinkTimes.reduce((s, v) => s + v, 0) / (thinkTimes.length || 1)),
    }, "Timing analysis");
  }

  exportPgn(session: GameSession): string {
    const pgn = movesToPgn(session.moves.map((m) => ({
      from: m.uci.slice(0, 2) as never,
      to: m.uci.slice(2, 4) as never,
      promotion: m.uci.length === 5 ? (m.uci[4] as never) : undefined,
      san: m.san,
      uci: m.uci,
      timestamp: m.timestamp,
    })));

    const header = [
      `[Event "Chess Research Session"]`,
      `[Site "localhost"]`,
      `[Date "${new Date(session.startedAt).toISOString().split("T")[0]}"]`,
      `[White "${session.color === "w" ? "Engine" : "Opponent"}"]`,
      `[Black "${session.color === "b" ? "Engine" : "Opponent"}"]`,
      `[Result "${session.result === "win" ? (session.color === "w" ? "1-0" : "0-1") : session.result === "loss" ? (session.color === "w" ? "0-1" : "1-0") : session.result === "draw" ? "1/2-1/2" : "*"}"]`,
      `[SessionId "${session.id}"]`,
    ].join("\n");

    return header + "\n\n" + pgn;
  }

  private async readNdjson(filePath: string): Promise<LogEvent[]> {
    return new Promise((resolve, reject) => {
      const events: LogEvent[] = [];
      const rl = createInterface({
        input: createReadStream(filePath),
        crlfDelay: Infinity,
      });

      rl.on("line", (line) => {
        if (!line.trim()) return;
        try {
          events.push(JSON.parse(line) as LogEvent);
        } catch { /* skip malformed lines */ }
      });

      rl.on("close", () => resolve(events));
      rl.on("error", reject);
    });
  }

  private reconstructSession(events: LogEvent[]): GameSession | null {
    const startEvt = events.find((e) => e.type === "session_start");
    const endEvt = events.find((e) => e.type === "session_end");
    if (!startEvt) return null;

    const moves = events
      .filter((e) => e.type === "move")
      .map((e) => e as unknown as MoveLogEntry);

    return {
      id: startEvt["sessionId"] as string,
      startedAt: startEvt._ts,
      endedAt: endEvt?._ts,
      url: startEvt["url"] as string,
      color: startEvt["color"] as never,
      result: endEvt?.["result"] as GameSession["result"],
      moves,
      finalFen: endEvt?.["finalFen"] as string | undefined,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
