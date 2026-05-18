import { createLogger } from "./logger/index.ts";
import { GameLogger } from "./logger/game-logger.ts";
import { ReplayTool } from "./logger/replay.ts";
import { BrowserManager } from "./automation/browser.ts";
import { SessionManager } from "./automation/session.ts";
import { BoardExtractor } from "./board/extractor.ts";
import { StockfishEngine } from "./engine/stockfish.ts";
import { GameSynchronizer } from "./sync/synchronizer.ts";
import { isGameOver, getGameResult } from "./board/index.ts";
import type {
  SessionConfig,
  BrowserConfig,
  BoardExtractorConfig,
  SyncConfig,
  EngineOptions,
  GameSession,
  SyncEvent,
  Color,
} from "./types.ts";

const logger = createLogger("chess-research");

export interface ResearchSessionConfig {
  session: SessionConfig;
  browser?: BrowserConfig;
  extractor?: BoardExtractorConfig;
  sync: Pick<SyncConfig, "color" | "autoMove" | "moveDelayMs" | "moveJitterMs">;
  engine?: EngineOptions;
  logDir?: string;
}

/**
 * High-level facade that wires all components together.
 *
 * Usage:
 *   const rs = new ChessResearchSession(config);
 *   await rs.start();
 *   // plays the game automatically
 *   await rs.waitForGameEnd();
 *   await rs.shutdown();
 */
export class ChessResearchSession {
  private browser: BrowserManager;
  private sessionMgr: SessionManager;
  private extractor: BoardExtractor;
  private engine: StockfishEngine;
  private synchronizer: GameSynchronizer | null = null;
  private gameLogger: GameLogger;
  private replay: ReplayTool;
  private config: ResearchSessionConfig;
  private gameEndResolve: ((result: string) => void) | null = null;

  constructor(config: ResearchSessionConfig) {
    this.config = config;
    this.browser = new BrowserManager(config.browser);
    this.sessionMgr = new SessionManager(config.session);
    this.extractor = new BoardExtractor(config.extractor);
    this.engine = new StockfishEngine();
    this.gameLogger = new GameLogger(config.logDir ?? "./logs/sessions");
    this.replay = new ReplayTool(config.logDir ?? "./logs/sessions");
  }

  async start(): Promise<void> {
    logger.info("Initializing Chess Research Session");

    await Promise.all([
      this.browser.launch(),
      this.engine.start(),
    ]);

    if (this.config.engine) {
      this.engine.configure(this.config.engine);
    }

    const page = await this.browser.newPage("main");
    const authenticated = await this.sessionMgr.authenticate(page);

    if (!authenticated) {
      throw new Error("Authentication failed — cannot start session");
    }

    const gs = this.gameLogger.startSession(
      this.config.session.url,
      this.config.sync.color as Color
    );

    this.synchronizer = new GameSynchronizer(
      page,
      this.engine,
      this.extractor,
      this.sessionMgr,
      this.gameLogger,
      {
        color: this.config.sync.color as Color,
        autoMove: this.config.sync.autoMove ?? true,
        moveDelayMs: this.config.sync.moveDelayMs ?? 300,
        moveJitterMs: this.config.sync.moveJitterMs ?? 400,
        maxRetries: 3,
        retryDelayMs: 2_000,
      },
      this.config.engine
    );

    this.synchronizer.on("event", async (event: SyncEvent) => {
      logger.debug({ event: event.type }, "Sync event");

      if (event.type === "game_over") {
        logger.info({ result: event.result }, "Game ended");
        this.gameLogger.endSession(
          event.result === "1-0"
            ? (this.config.sync.color === "w" ? "win" : "loss")
            : event.result === "0-1"
            ? (this.config.sync.color === "b" ? "win" : "loss")
            : "draw"
        );
        this.gameEndResolve?.(event.result);
        this.gameEndResolve = null;
      }

      if (event.type === "session_lost") {
        logger.warn({ reason: event.reason }, "Session lost");
      }

      if (event.type === "session_recovered") {
        logger.info("Session recovered");
      }
    });

    await this.synchronizer.start();
    logger.info("Chess Research Session active");
  }

  async waitForGameEnd(timeoutMs = 3_600_000): Promise<string> {
    return new Promise((resolve, reject) => {
      this.gameEndResolve = resolve;
      const timeout = setTimeout(() => {
        reject(new Error("Game timeout — waited " + timeoutMs + "ms"));
      }, timeoutMs);

      const origResolve = this.gameEndResolve;
      this.gameEndResolve = (result) => {
        clearTimeout(timeout);
        origResolve(result);
      };
    });
  }

  async screenshot(path?: string): Promise<Buffer> {
    return this.browser.screenshot("main", path);
  }

  async saveSession(storagePath?: string): Promise<void> {
    if (storagePath) {
      await this.browser.saveStorageState(storagePath);
    }
  }

  async shutdown(): Promise<void> {
    logger.info("Shutting down Chess Research Session");
    this.synchronizer?.stop();
    await Promise.all([
      this.engine.close(),
      this.browser.close(),
    ]);
    logger.info("Shutdown complete");
  }

  getGameLogger(): GameLogger { return this.gameLogger; }
  getReplayTool(): ReplayTool { return this.replay; }
  getEngine(): StockfishEngine { return this.engine; }
  getSynchronizer(): GameSynchronizer | null { return this.synchronizer; }

  async analyzePosition(fen: string, options?: EngineOptions) {
    return this.engine.analyzePosition(fen, options ?? { depth: 20 });
  }
}
