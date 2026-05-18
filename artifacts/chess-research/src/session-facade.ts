import { createLogger } from "./logger/index.ts";
import { GameLogger } from "./logger/game-logger.ts";
import { ReplayTool } from "./logger/replay.ts";
import { BrowserManager } from "./automation/browser.ts";
import { SessionManager } from "./automation/session.ts";
import { BoardExtractor } from "./board/extractor.ts";
import { StockfishEngine } from "./engine/stockfish.ts";
import { GameSynchronizer } from "./sync/synchronizer.ts";
import { CFWebSocketCapture } from "./platforms/chessfriends-ws.ts";
import { isGameOver, getGameResult } from "./board/index.ts";
import type { Page } from "playwright";
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
  /**
   * Optional callback called after authentication to start / join a match.
   * Return true if the match was successfully started, false to abort.
   */
  matchInitiator?: (page: Page) => Promise<boolean>;
  /**
   * Whether to enable WebSocket frame capture (default: true).
   * When enabled, WS game-state events feed into the board extractor
   * to supplement (and in some cases replace) DOM polling.
   */
  enableWsCapture?: boolean;
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
  private wsCapture: CFWebSocketCapture | null = null;

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

    // ── WebSocket capture ──────────────────────────────────────────────────────
    // Attach BEFORE page.goto() so the listener is in place when the WS
    // handshake occurs. ChessFriends game-state frames arrive after frame 60+
    // so we capture everything without a count limit.
    if (this.config.enableWsCapture !== false) {
      this.wsCapture = new CFWebSocketCapture();
      this.wsCapture.attach(page);

      this.wsCapture.on("game_event", (event) => {
        // Feed FEN from WS events into the extractor so DOM polling can be
        // skipped or confirmed without an additional page.evaluate() round-trip.
        if ("fen" in event && typeof event.fen === "string") {
          this.extractor.setLastKnownFen(event.fen);
          logger.debug({ fen: event.fen, wsEventType: event.type }, "WS FEN fed to extractor");
        }
        this.gameLogger.recordEvent("ws_game_event", { wsEventType: event.type, ...(event as object) });
      });

      logger.info("WebSocket capture enabled — attached to page before navigation");
    }

    const authenticated = await this.sessionMgr.authenticate(page);

    if (!authenticated) {
      throw new Error("Authentication failed — cannot start session");
    }

    if (this.config.matchInitiator) {
      logger.info("Invoking matchInitiator to start/join a match");
      const matchStarted = await this.config.matchInitiator(page);
      if (!matchStarted) {
        throw new Error("matchInitiator returned false — could not start a match. Make sure you are logged in and the site is reachable.");
      }
      logger.info("Match started successfully via matchInitiator");
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

      // Keep WS capture's internal FEN in sync with confirmed DOM FEN
      if (
        this.wsCapture &&
        (event.type === "board_detected" || event.type === "move_executed")
      ) {
        const state = "state" in event ? event.state : undefined;
        if (state?.fen) this.wsCapture.setCurrentFen(state.fen);
      }

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
  getWsCapture(): CFWebSocketCapture | null { return this.wsCapture; }

  async analyzePosition(fen: string, options?: EngineOptions) {
    return this.engine.analyzePosition(fen, options ?? { depth: 20 });
  }
}
