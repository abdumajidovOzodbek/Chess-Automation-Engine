import { EventEmitter } from "events";
import { createLogger } from "../logger/index.ts";
import { GameLogger } from "../logger/game-logger.ts";
import { BoardExtractor } from "../board/extractor.ts";
import { StockfishEngine } from "../engine/stockfish.ts";
import { SessionManager } from "../automation/session.ts";
import {
  validateMove,
  isGameOver,
  getGameResult,
  stateConsistencyCheck,
} from "../board/index.ts";
import type { Page } from "playwright";
import type {
  BoardState,
  SyncConfig,
  SyncEvent,
  EngineMove,
  BoardMove,
  Color,
  EngineOptions,
  Square,
  PieceType,
} from "../types.ts";

const logger = createLogger("synchronizer");

export type SynchronizerStatus = "idle" | "running" | "paused" | "recovering" | "stopped";

export class GameSynchronizer extends EventEmitter {
  private status: SynchronizerStatus = "idle";
  private config: Required<SyncConfig>;
  private currentState: BoardState | null = null;
  private isProcessingMove = false;
  private retryCount = 0;
  private engineOptions: EngineOptions;

  constructor(
    private readonly page: Page,
    private readonly engine: StockfishEngine,
    private readonly extractor: BoardExtractor,
    private readonly session: SessionManager,
    private readonly gameLogger: GameLogger,
    config: SyncConfig,
    engineOptions: EngineOptions = {}
  ) {
    super();
    this.config = {
      color: config.color,
      autoMove: config.autoMove ?? true,
      moveDelayMs: config.moveDelayMs ?? 200,
      moveJitterMs: config.moveJitterMs ?? 300,
      maxRetries: config.maxRetries ?? 3,
      retryDelayMs: config.retryDelayMs ?? 2_000,
    };
    this.engineOptions = {
      depth: 18,
      movetime: 3_000,
      threads: 2,
      hashMB: 128,
      ...engineOptions,
    };
  }

  async start(): Promise<void> {
    if (this.status === "running") return;
    logger.info({ color: this.config.color }, "Starting game synchronizer");
    this.status = "running";

    const initial = await this.extractor.extract(this.page);
    if (initial) {
      this.currentState = initial;
      this.emit("event", { type: "board_detected", state: initial } satisfies SyncEvent);
      logger.info({ fen: initial.fen, turn: initial.turn }, "Initial board state detected");

      if (initial.turn === this.config.color && !isGameOver(initial)) {
        await this.handleOurTurn(initial);
      }
    }

    this.extractor.startPolling(this.page, async (state) => {
      await this.onBoardChange(state);
    });
  }

  pause(): void {
    this.status = "paused";
    this.extractor.stopPolling();
    logger.info("Synchronizer paused");
  }

  async resume(): Promise<void> {
    if (this.status !== "paused") return;
    this.status = "running";
    const state = await this.extractor.extract(this.page);
    if (state) this.currentState = state;
    this.extractor.startPolling(this.page, async (s) => { await this.onBoardChange(s); });
    logger.info("Synchronizer resumed");
  }

  stop(): void {
    this.extractor.stopPolling();
    this.status = "stopped";
    logger.info("Synchronizer stopped");
  }

  private async onBoardChange(newState: BoardState): Promise<void> {
    if (this.status !== "running") return;
    if (this.isProcessingMove) return;

    const consistency = stateConsistencyCheck(newState);
    if (!consistency.valid) {
      logger.warn({ reason: consistency.reason }, "Board state consistency check failed");
      this.gameLogger.recordEvent("state_inconsistency", { reason: consistency.reason, fen: newState.fen });
      return;
    }

    this.currentState = newState;
    this.session.touchActivity();
    this.gameLogger.recordBoardState(newState);

    this.emit("event", { type: "board_detected", state: newState } satisfies SyncEvent);

    if (isGameOver(newState)) {
      const result = getGameResult(newState);
      logger.info({ result, fen: newState.fen }, "Game over detected");
      this.emit("event", { type: "game_over", result } satisfies SyncEvent);
      this.stop();
      return;
    }

    if (newState.turn === this.config.color) {
      this.emit("event", { type: "move_required", state: newState, color: this.config.color } satisfies SyncEvent);
      await this.handleOurTurn(newState);
    }
  }

  private async handleOurTurn(state: BoardState): Promise<void> {
    if (this.isProcessingMove) return;
    this.isProcessingMove = true;
    this.retryCount = 0;

    try {
      const engineMove = await this.getEngineMove(state);
      if (!engineMove) {
        logger.warn("Engine returned no move");
        this.isProcessingMove = false;
        return;
      }

      this.emit("event", { type: "engine_move", move: engineMove } satisfies SyncEvent);

      const validation = validateMove(state, engineMove.uci);
      if (!validation.valid) {
        logger.error({ uci: engineMove.uci, reason: validation.reason }, "Engine move failed validation");
        this.gameLogger.recordEvent("validation_failure", {
          uci: engineMove.uci,
          reason: validation.reason,
          fen: state.fen,
        });
        this.isProcessingMove = false;
        return;
      }

      await this.executeMove(state, engineMove);
    } catch (err) {
      logger.error({ err }, "Error during move handling");
      this.gameLogger.recordEvent("move_error", { error: String(err) });
    } finally {
      this.isProcessingMove = false;
    }
  }

  private async getEngineMove(state: BoardState): Promise<EngineMove | null> {
    if (!this.engine.isReady()) {
      logger.warn("Engine not ready — waiting");
      await sleep(1_000);
      if (!this.engine.isReady()) return null;
    }

    this.gameLogger.markThinkStart();
    logger.debug({ fen: state.fen }, "Requesting engine move");

    try {
      const move = await this.engine.getBestMove(state.fen, this.engineOptions);
      return move;
    } catch (err) {
      logger.error({ err }, "Engine getBestMove failed");
      return null;
    }
  }

  private async executeMove(state: BoardState, engineMove: EngineMove): Promise<void> {
    const delay = this.config.moveDelayMs + Math.random() * this.config.moveJitterMs;
    logger.debug({ delay }, "Waiting before move execution");
    await sleep(delay);

    this.gameLogger.markMoveStart();

    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      logger.info({ uci: engineMove.uci, attempt }, "Executing move");
      const success = await this.extractor.executeMoveOnBoard(this.page, engineMove.uci);

      if (success) {
        const boardMove: BoardMove = {
          from: engineMove.from,
          to: engineMove.to,
          promotion: engineMove.promotion,
          uci: engineMove.uci,
          timestamp: Date.now(),
        };

        this.gameLogger.recordMove(state, boardMove, engineMove, "engine");
        this.emit("event", { type: "move_executed", move: boardMove } satisfies SyncEvent);
        this.retryCount = 0;
        return;
      }

      logger.warn({ attempt, maxRetries: this.config.maxRetries }, "Move execution failed, retrying");
      await sleep(this.config.retryDelayMs);

      const recovered = await this.attemptRecovery();
      if (!recovered) {
        const boardMove: BoardMove = {
          from: engineMove.from,
          to: engineMove.to,
          promotion: engineMove.promotion,
          uci: engineMove.uci,
          timestamp: Date.now(),
        };
        this.emit("event", {
          type: "move_failed",
          move: boardMove,
          reason: `Failed after ${attempt} attempts`,
        } satisfies SyncEvent);
        return;
      }
    }
  }

  private async attemptRecovery(): Promise<boolean> {
    this.status = "recovering";
    logger.warn("Attempting session recovery");
    this.emit("event", { type: "session_lost", reason: "move execution failure" } satisfies SyncEvent);

    const recovered = await this.session.recover(this.page);
    if (recovered) {
      this.status = "running";
      this.emit("event", { type: "session_recovered" } satisfies SyncEvent);
      logger.info("Session recovered");
      return true;
    }

    this.status = "stopped";
    return false;
  }

  getCurrentState(): BoardState | null { return this.currentState; }
  getStatus(): SynchronizerStatus { return this.status; }
  getConfig(): Required<SyncConfig> { return { ...this.config }; }

  setEngineOptions(opts: Partial<EngineOptions>): void {
    this.engineOptions = { ...this.engineOptions, ...opts };
    logger.debug({ opts }, "Engine options updated");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
