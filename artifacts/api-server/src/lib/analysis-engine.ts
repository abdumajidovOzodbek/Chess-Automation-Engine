import { StockfishEngine } from "@workspace/chess-research";
import type { EngineOptions } from "@workspace/chess-research";
import type { UciInfo } from "@workspace/chess-research";
import { logger } from "./logger.js";

type UciInfoArr = Awaited<ReturnType<StockfishEngine["analyzePosition"]>>;

class AnalysisEnginePool {
  private engine: StockfishEngine | null = null;
  private initPromise: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  private async ensureReady(): Promise<StockfishEngine> {
    if (this.engine?.isReady()) return this.engine;

    if (!this.initPromise) {
      this.initPromise = (async () => {
        this.engine = new StockfishEngine();
        await this.engine.start();
        logger.info("Analysis engine initialized");
      })().catch((err) => {
        this.engine = null;
        this.initPromise = null;
        throw err;
      });
    }

    await this.initPromise;
    return this.engine!;
  }

  async analyze(fen: string, options: EngineOptions = {}): Promise<{ lines: UciInfoArr; thinkingMs: number }> {
    const run = this.queue.then(async () => {
      const eng = await this.ensureReady();
      const start = Date.now();
      const lines = await eng.analyzePosition(fen, {
        depth: options.depth ?? 18,
        movetime: options.movetime ?? 3000,
        multiPV: options.multiPV ?? 3,
      });
      const thinkingMs = Date.now() - start;
      return { lines, thinkingMs };
    });

    this.queue = run.catch(() => {});
    return run;
  }
}

export const analysisEngine = new AnalysisEnginePool();
