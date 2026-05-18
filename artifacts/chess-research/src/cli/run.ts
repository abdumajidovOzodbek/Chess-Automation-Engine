#!/usr/bin/env node
import { Command } from "commander";
import { createLogger } from "../logger/index.ts";
import { ChessResearchSession } from "../session-facade.ts";
import { StockfishEngine } from "../engine/stockfish.ts";
import { ReplayTool } from "../logger/replay.ts";
import { parseFen } from "../board/index.ts";
import type { Color } from "../types.ts";

const logger = createLogger("cli");

const program = new Command();

program
  .name("chess-research")
  .description("Chess browser automation research framework")
  .version("0.1.0");

program
  .command("run")
  .description("Start an automated chess session on a target URL")
  .requiredOption("-u, --url <url>", "Target chess platform URL")
  .requiredOption("-c, --color <color>", "Your piece color: w or b", "w")
  .option("--username <username>", "Login username")
  .option("--password <password>", "Login password")
  .option("--headless", "Run browser in headless mode", false)
  .option("--depth <depth>", "Engine search depth", "18")
  .option("--movetime <ms>", "Max engine think time in ms", "3000")
  .option("--delay <ms>", "Base delay before each move in ms", "300")
  .option("--jitter <ms>", "Random jitter added to delay in ms", "400")
  .option("--slow-mo <ms>", "Playwright slowMo for browser actions", "0")
  .option("--log-dir <dir>", "Directory for session logs", "./logs/sessions")
  .option("--save-state <path>", "Save browser storage state for future sessions")
  .option("--load-state <path>", "Load a previously saved browser storage state")
  .action(async (opts) => {
    const color = opts.color as Color;
    if (color !== "w" && color !== "b") {
      logger.error("Color must be 'w' or 'b'");
      process.exit(1);
    }

    const session = new ChessResearchSession({
      session: {
        url: opts.url as string,
        username: opts.username as string | undefined,
        password: opts.password as string | undefined,
        headless: opts.headless as boolean,
      },
      browser: {
        headless: opts.headless as boolean,
        slowMo: parseInt(opts.slowMo as string, 10),
        storageStatePath: opts.loadState as string | undefined,
      },
      sync: {
        color,
        autoMove: true,
        moveDelayMs: parseInt(opts.delay as string, 10),
        moveJitterMs: parseInt(opts.jitter as string, 10),
      },
      engine: {
        depth: parseInt(opts.depth as string, 10),
        movetime: parseInt(opts.movetime as string, 10),
      },
      logDir: opts.logDir as string,
    });

    process.on("SIGINT", async () => {
      logger.info("SIGINT received — shutting down");
      await session.shutdown();
      process.exit(0);
    });

    try {
      await session.start();
      logger.info("Session started — waiting for game to end (Ctrl+C to stop)");

      const result = await session.waitForGameEnd();
      logger.info({ result }, "Game completed");

      if (opts.saveState) {
        await session.saveSession(opts.saveState as string);
      }
    } catch (err) {
      logger.error({ err }, "Session error");
    } finally {
      await session.shutdown();
    }
  });

program
  .command("analyze")
  .description("Analyze a FEN position with Stockfish")
  .requiredOption("-f, --fen <fen>", "FEN string to analyze")
  .option("--depth <depth>", "Search depth", "20")
  .option("--movetime <ms>", "Max think time in ms", "5000")
  .option("--multipv <n>", "Number of best lines to return", "3")
  .action(async (opts) => {
    const fen = opts.fen as string;
    const state = parseFen(fen);

    logger.info({
      fen,
      turn: state.turn,
      moveNumber: state.moveNumber,
      isCheck: state.isCheck,
    }, "Analyzing position");

    const engine = new StockfishEngine();
    await engine.start();

    engine.configure({
      multiPV: parseInt(opts.multipv as string, 10),
      threads: 2,
      hashMB: 128,
    });

    engine.on("info", (info) => {
      if (info.pv && info.score) {
        const scoreStr = info.score.type === "mate"
          ? `mate in ${Math.abs(info.score.value)}`
          : `${(info.score.value / 100).toFixed(2)}`;
        logger.info({
          depth: info.depth,
          score: scoreStr,
          pv: info.pv.slice(0, 5).join(" "),
          nodes: info.nodes,
          nps: info.nps,
        }, "Analysis line");
      }
    });

    try {
      const bestMove = await engine.getBestMove(fen, {
        depth: parseInt(opts.depth as string, 10),
        movetime: parseInt(opts.movetime as string, 10),
      });

      if (bestMove) {
        const scoreStr = bestMove.score
          ? bestMove.score.type === "mate"
            ? `mate in ${Math.abs(bestMove.score.value)}`
            : `${(bestMove.score.value / 100).toFixed(2)}`
          : "unknown";
        logger.info({
          bestMove: bestMove.uci,
          score: scoreStr,
          depth: bestMove.depth,
          nodes: bestMove.nodes,
        }, "Best move found");
      }
    } finally {
      await engine.close();
    }
  });

program
  .command("replay")
  .description("Replay a recorded game session")
  .option("-s, --session-id <id>", "Session ID to replay")
  .option("-f, --file <path>", "Path to session NDJSON log file")
  .option("--log-dir <dir>", "Session log directory", "./logs/sessions")
  .option("--speed <multiplier>", "Playback speed multiplier", "1")
  .option("--start-at <move>", "Start replay at this move number", "1")
  .option("--stop-at <move>", "Stop replay at this move number")
  .option("--show-engine", "Show engine analysis during replay", false)
  .option("--export-pgn", "Export session as PGN", false)
  .action(async (opts) => {
    const replayTool = new ReplayTool(opts.logDir as string);

    if (!opts.sessionId && !opts.file) {
      const sessions = await replayTool.listSessions();
      if (!sessions.length) {
        logger.error("No sessions found in log directory");
        process.exit(1);
      }

      logger.info({ count: sessions.length }, "Available sessions:");
      for (const s of sessions) {
        logger.info({
          id: s.id,
          date: new Date(s.startedAt).toISOString(),
          moves: s.moves,
          result: s.result,
        }, "Session");
      }
      return;
    }

    if (opts.exportPgn) {
      const session = opts.sessionId
        ? await replayTool.loadSession(opts.sessionId as string)
        : null;

      if (!session) { logger.error("Session not found"); process.exit(1); }

      const pgn = replayTool.exportPgn(session);
      logger.info({ pgn }, "PGN export");
      process.stdout.write(pgn + "\n");
      return;
    }

    await replayTool.replay(
      {
        sessionId: opts.sessionId as string | undefined,
        logFile: opts.file as string | undefined,
        speedMultiplier: parseFloat(opts.speed as string),
        startAtMove: parseInt(opts.startAt as string, 10),
        stopAtMove: opts.stopAt ? parseInt(opts.stopAt as string, 10) : undefined,
        showEngine: opts.showEngine as boolean,
      },
      async (entry, state, index, total) => {
        logger.info({
          progress: `${index + 1}/${total}`,
          move: entry.uci,
          san: entry.san,
          fen: state.fen,
          ...(opts.showEngine && entry.engineMove
            ? { score: entry.engineMove.score, depth: entry.engineMove.depth }
            : {}),
        }, "Replaying move");
      }
    );
  });

program
  .command("sessions")
  .description("List all recorded game sessions")
  .option("--log-dir <dir>", "Session log directory", "./logs/sessions")
  .action(async (opts) => {
    const replayTool = new ReplayTool(opts.logDir as string);
    const sessions = await replayTool.listSessions();

    if (!sessions.length) {
      logger.info("No sessions recorded yet");
      return;
    }

    logger.info({ count: sessions.length }, "Recorded sessions:");
    for (const s of sessions) {
      logger.info({
        id: s.id,
        date: new Date(s.startedAt).toISOString(),
        moves: s.moves,
        result: s.result,
      }, "Session");
    }
  });

program.parseAsync(process.argv).catch((err) => {
  logger.error({ err }, "CLI error");
  process.exit(1);
});
