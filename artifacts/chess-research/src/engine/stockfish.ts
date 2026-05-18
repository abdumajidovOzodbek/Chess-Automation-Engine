import { spawn, ChildProcess } from "child_process";
import { createRequire } from "module";
import { EventEmitter } from "events";
import { createLogger } from "../logger/index.ts";
import {
  parseUciMessage,
  buildUciCommand,
  buildGoCommand,
  uciToEngineMove,
} from "./uci.ts";
import type { UciInfo } from "./uci.ts";
import type { EngineMove, EngineOptions } from "../types.ts";

const logger = createLogger("stockfish");

export type StockfishStatus = "idle" | "initializing" | "ready" | "thinking" | "error" | "closed";

export class StockfishEngine extends EventEmitter {
  private proc: ChildProcess | null = null;
  private status: StockfishStatus = "idle";
  private readyResolve: (() => void) | null = null;
  private bestMoveResolve: ((move: EngineMove | null) => void) | null = null;
  private bestMoveReject: ((err: Error) => void) | null = null;
  private lastInfo: UciInfo = {};
  private infoHistory: UciInfo[] = [];
  private outputBuffer = "";
  private engineName = "Stockfish";
  private thinkingStart = 0;

  async start(): Promise<void> {
    if (this.status === "ready") return;
    this.status = "initializing";
    logger.info("Starting Stockfish engine");

    const stockfishPath = await this.resolveStockfishBinary();
    logger.debug({ path: stockfishPath }, "Resolved Stockfish binary");

    this.proc = spawn(stockfishPath, [], { stdio: ["pipe", "pipe", "pipe"] });

    this.proc.stdout?.setEncoding("utf8");
    this.proc.stdout?.on("data", (chunk: string) => this.handleOutput(chunk));
    this.proc.stderr?.on("data", (data: string) => {
      logger.debug({ stderr: data.trim() }, "Stockfish stderr");
    });

    this.proc.on("close", (code) => {
      logger.info({ code }, "Stockfish process closed");
      this.status = "closed";
      this.emit("closed", code);
    });

    this.proc.on("error", (err) => {
      logger.error({ err }, "Stockfish process error");
      this.status = "error";
      this.bestMoveReject?.(err);
    });

    await this.waitForReady();
    logger.info({ engine: this.engineName }, "Stockfish ready");
  }

  private async resolveStockfishBinary(): Promise<string> {
    const which = await import("child_process");
    return new Promise((resolve) => {
      const proc = which.spawn("which", ["stockfish"]);
      let out = "";
      proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
      proc.on("close", (code) => {
        if (code === 0 && out.trim()) {
          resolve(out.trim());
        } else {
          try {
            const req = createRequire(import.meta.url);
            const sfPkg = req.resolve("stockfish");
            resolve(sfPkg);
          } catch {
            resolve("stockfish");
          }
        }
      });
    });
  }

  private async waitForReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      const timeout = setTimeout(() => {
        reject(new Error("Stockfish initialization timeout (10s)"));
      }, 10_000);

      const origResolve = this.readyResolve;
      this.readyResolve = () => {
        clearTimeout(timeout);
        origResolve();
      };

      this.send("uci");
    });
  }

  configure(options: EngineOptions): void {
    if (this.status !== "ready") throw new Error("Engine not ready");
    const cmds = buildUciCommand(options);
    for (const cmd of cmds) {
      this.send(cmd);
      logger.debug({ cmd }, "Engine option set");
    }
  }

  async getBestMove(fen: string, options: EngineOptions = {}): Promise<EngineMove | null> {
    if (this.status !== "ready") throw new Error("Engine not ready — call start() first");
    this.status = "thinking";
    this.infoHistory = [];
    this.lastInfo = {};
    this.thinkingStart = Date.now();

    return new Promise((resolve, reject) => {
      this.bestMoveResolve = resolve;
      this.bestMoveReject = reject;

      const timeout = setTimeout(() => {
        this.send("stop");
        reject(new Error("Engine thinking timeout"));
      }, (options.movetime ?? 5_000) + 5_000);

      const origResolve = this.bestMoveResolve;
      this.bestMoveResolve = (move) => {
        clearTimeout(timeout);
        origResolve(move);
      };

      this.send(`position fen ${fen}`);
      this.send(buildGoCommand(options));
    });
  }

  async analyzePosition(fen: string, options: EngineOptions = {}): Promise<UciInfo[]> {
    if (this.status !== "ready") throw new Error("Engine not ready");
    this.infoHistory = [];

    await this.getBestMove(fen, { ...options, depth: options.depth ?? 15 });
    return [...this.infoHistory];
  }

  stop(): void {
    if (this.status === "thinking") {
      this.send("stop");
    }
  }

  async close(): Promise<void> {
    if (this.proc && this.status !== "closed") {
      this.send("quit");
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          this.proc?.kill("SIGKILL");
          resolve();
        }, 2_000);
        this.proc?.once("close", () => { clearTimeout(t); resolve(); });
      });
    }
    this.status = "closed";
    logger.info("Stockfish closed");
  }

  private send(cmd: string): void {
    if (!this.proc?.stdin?.writable) {
      logger.warn({ cmd }, "Cannot send — stdin not writable");
      return;
    }
    logger.debug({ cmd }, "→ Stockfish");
    this.proc.stdin.write(cmd + "\n");
  }

  private handleOutput(chunk: string): void {
    this.outputBuffer += chunk;
    const lines = this.outputBuffer.split("\n");
    this.outputBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      logger.debug({ line }, "← Stockfish");
      this.processLine(line);
    }
  }

  private processLine(line: string): void {
    const msg = parseUciMessage(line);

    switch (msg.type) {
      case "id":
        if (msg.name) this.engineName = msg.name;
        break;

      case "uciok":
        this.send("setoption name UCI_AnalyseMode value false");
        this.send("isready");
        break;

      case "readyok":
        if (this.status === "initializing") {
          this.status = "ready";
          this.readyResolve?.();
          this.readyResolve = null;
        }
        break;

      case "info":
        this.lastInfo = { ...this.lastInfo, ...msg.data };
        if (msg.data.pv) {
          this.infoHistory.push({ ...msg.data });
          this.emit("info", msg.data);
        }
        break;

      case "bestmove": {
        const thinkingMs = Date.now() - this.thinkingStart;
        this.status = "ready";
        const move = uciToEngineMove(msg.data.move, this.lastInfo);
        logger.info({ move: msg.data.move, thinkingMs, score: this.lastInfo.score }, "Best move found");
        this.emit("bestmove", move);
        this.bestMoveResolve?.(move);
        this.bestMoveResolve = null;
        this.bestMoveReject = null;
        break;
      }

      default: break;
    }
  }

  getStatus(): StockfishStatus { return this.status; }
  getEngineName(): string { return this.engineName; }
  getLastInfo(): UciInfo { return this.lastInfo; }
  isReady(): boolean { return this.status === "ready"; }
}
