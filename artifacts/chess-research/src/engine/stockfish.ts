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
    // 1. Explicit env var (set by the API server workflow)
    if (process.env.STOCKFISH_PATH) {
      logger.debug({ path: process.env.STOCKFISH_PATH }, "Using STOCKFISH_PATH env var");
      return process.env.STOCKFISH_PATH;
    }

    // 2. Try `which stockfish` — works when stockfish is in PATH
    const cp = await import("child_process");
    const fromWhich = await new Promise<string | null>((resolve) => {
      const proc = cp.spawn("which", ["stockfish"]);
      let out = "";
      proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
      proc.on("close", (code) => resolve(code === 0 && out.trim() ? out.trim() : null));
    });
    if (fromWhich) {
      logger.debug({ path: fromWhich }, "Found stockfish via which");
      return fromWhich;
    }

    // 3. Known Nix store locations (Replit NixOS environment)
    const { existsSync } = await import("fs");
    const nixCandidates = [
      "/nix/store/04bgcfhfqhm7r9ll8nfx7hymb8y8r5zk-stockfish-16/bin/stockfish",
      "/nix/store/6mazfacbfr2c2di734v0rb4820ipa1xb-stockfish-15/bin/stockfish",
      "/nix/store/7hmnik2vkcxw59f2pr6ipk34fj6y7w15-stockfish-14.1/bin/stockfish",
    ];
    for (const p of nixCandidates) {
      if (existsSync(p)) {
        logger.debug({ path: p }, "Found stockfish in Nix store");
        return p;
      }
    }

    // 4. Dynamic Nix store search via ls
    try {
      const found = await new Promise<string | null>((resolve) => {
        const proc = cp.spawn("sh", ["-c", "ls /nix/store/*-stockfish-*/bin/stockfish 2>/dev/null | head -1"]);
        let out = "";
        proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
        proc.on("close", () => resolve(out.trim() || null));
      });
      if (found) {
        logger.debug({ path: found }, "Found stockfish via nix store search");
        return found;
      }
    } catch { /* ignore */ }

    // 5. Fallback to system PATH (may fail)
    logger.warn("Could not locate stockfish binary — falling back to 'stockfish' in PATH");
    return "stockfish";
  }

  private async waitForReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      const timeout = setTimeout(() => {
        reject(new Error("Stockfish initialization timeout (30s)"));
      }, 30_000);

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
