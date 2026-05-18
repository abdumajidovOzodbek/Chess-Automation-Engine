import { randomUUID } from "crypto";
import { ChessResearchSession } from "@workspace/chess-research";
import type { MoveLogEntry, BoardState } from "@workspace/chess-research";
import type { CFWebSocketCapture } from "@workspace/chess-research/platforms";
import {
  CHESSFRIENDS_SESSION_DEFAULTS,
  CHESSFRIENDS_EXTRACTOR_CONFIG,
  startChessfriendsMatch,
} from "@workspace/chess-research/platforms";
import { logger } from "./logger.js";

export type SessionStatus = "starting" | "active" | "paused" | "stopped" | "error";

export interface SessionConfigSnapshot {
  url: string;
  color: string;
  depth: number;
  movetime: number;
  moveDelayMs: number;
  moveJitterMs: number;
  headless: boolean;
}

export interface SessionRecord {
  id: string;
  status: SessionStatus;
  phase?: string;
  url: string;
  color: "w" | "b";
  startedAt: number;
  endedAt?: number;
  moveCount: number;
  result?: string;
  currentFen?: string;
  lastMove?: string;
  isCheck?: boolean;
  config: SessionConfigSnapshot;
  facade: ChessResearchSession | null;
  moves: MoveLogEntry[];
  lastBoardState?: BoardState;
  errorMessage?: string;
}

export interface SessionInput {
  url: string;
  color: "w" | "b";
  username?: string | null;
  password?: string | null;
  depth?: number | null;
  movetime?: number | null;
  moveDelayMs?: number | null;
  moveJitterMs?: number | null;
  headless?: boolean | null;
}

const sessions = new Map<string, SessionRecord>();

export function listSessions(): SessionRecord[] {
  return Array.from(sessions.values()).sort((a, b) => b.startedAt - a.startedAt);
}

export function getSession(id: string): SessionRecord | undefined {
  return sessions.get(id);
}

export function getSessionWsCapture(id: string): CFWebSocketCapture | null {
  const record = sessions.get(id);
  return record?.facade?.getWsCapture() ?? null;
}

export async function startSession(input: SessionInput): Promise<SessionRecord> {
  const id = randomUUID();

  const config: SessionConfigSnapshot = {
    url: input.url,
    color: input.color,
    depth: input.depth ?? 18,
    movetime: input.movetime ?? 3000,
    moveDelayMs: input.moveDelayMs ?? 300,
    moveJitterMs: input.moveJitterMs ?? 400,
    headless: input.headless ?? true,
  };

  const record: SessionRecord = {
    id,
    status: "starting",
    phase: "Launching browser",
    url: input.url,
    color: input.color,
    startedAt: Date.now(),
    moveCount: 0,
    config,
    facade: null,
    moves: [],
  };

  sessions.set(id, record);

  const isChessfriends = input.url.includes("chessfriends.com");

  const facade = new ChessResearchSession({
    session: {
      url: input.url,
      username: input.username ?? undefined,
      password: input.password ?? undefined,
      headless: config.headless,
      ...(isChessfriends ? CHESSFRIENDS_SESSION_DEFAULTS : {}),
    },
    browser: {
      headless: config.headless,
    },
    extractor: isChessfriends ? CHESSFRIENDS_EXTRACTOR_CONFIG : undefined,
    sync: {
      color: input.color,
      autoMove: true,
      moveDelayMs: config.moveDelayMs,
      moveJitterMs: config.moveJitterMs,
    },
    engine: {
      depth: config.depth,
      movetime: config.movetime,
    },
    logDir: "./logs/sessions",
    matchInitiator: isChessfriends ? startChessfriendsMatch : undefined,
    // Enable WS capture for ChessFriends — game-state arrives via WS JSON-RPC
    enableWsCapture: isChessfriends,
  });

  record.facade = facade;

  facade.start()
    .then(() => {
      record.status = "active";
      record.phase = "Playing";
      record.errorMessage = undefined;
      logger.info({ sessionId: id }, "Session started successfully");

      const sync = facade.getSynchronizer();
      if (sync) {
        sync.on("event", (event) => {
          const gameLog = facade.getGameLogger();
          const moves = gameLog.getMoveHistory();
          record.moves = [...moves];
          record.moveCount = moves.length;

          if (event.type === "board_detected" || event.type === "move_executed") {
            const state = "state" in event ? event.state : undefined;
            if (state) {
              record.lastBoardState = state;
              record.currentFen = state.fen;
              record.isCheck = state.isCheck;
            }
          }

          if (event.type === "move_executed") {
            const move = "move" in event ? event.move : undefined;
            if (move) {
              record.lastMove = move.uci ?? (move.from + move.to);
            }
          }

          if (event.type === "game_over") {
            record.status = "stopped";
            record.endedAt = Date.now();
            record.result = "result" in event ? String(event.result) : undefined;
            const finalMoves = facade.getGameLogger().getMoveHistory();
            record.moves = [...finalMoves];
            record.moveCount = finalMoves.length;
            logger.info({ sessionId: id, result: record.result }, "Session game over");
          }
        });
      }
    })
    .catch(async (err: unknown) => {
      record.status = "error";
      record.endedAt = Date.now();
      record.errorMessage = err instanceof Error ? err.message : String(err);
      logger.error({ sessionId: id, err }, "Session start failed");
      // Always shut down the browser on failure to avoid zombie Playwright processes
      try { await facade.shutdown(); } catch { /* ignore shutdown errors */ }
      record.facade = null;
    });

  return record;
}

export async function stopSession(id: string): Promise<SessionRecord | null> {
  const record = sessions.get(id);
  if (!record) return null;

  if (record.facade && record.status !== "stopped") {
    try {
      record.status = "stopped";
      record.endedAt = Date.now();
      const finalMoves = record.facade.getGameLogger().getMoveHistory();
      record.moves = [...finalMoves];
      record.moveCount = finalMoves.length;
      await record.facade.shutdown();
    } catch (err) {
      logger.warn({ id, err }, "Error during session shutdown");
    }
    record.facade = null;
  }

  return record;
}
