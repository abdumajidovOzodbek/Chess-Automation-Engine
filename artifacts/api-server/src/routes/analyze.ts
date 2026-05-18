import { Router, type IRouter } from "express";
import { AnalyzePositionBody } from "@workspace/api-zod";
import { analysisEngine } from "../lib/analysis-engine.js";
import { validateFen, parseFen } from "@workspace/chess-research";

const router: IRouter = Router();

router.post("/analyze", async (req, res) => {
  const parsed = AnalyzePositionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { fen, depth, movetime, multiPv } = parsed.data;

  const validation = validateFen(fen);
  if (!validation.valid) {
    res.status(400).json({ error: `Invalid FEN: ${validation.reason ?? "unknown"}` });
    return;
  }

  try {
    const { lines, thinkingMs } = await analysisEngine.analyze(fen, {
      depth: depth ?? undefined,
      movetime: movetime ?? undefined,
      multiPV: multiPv ?? undefined,
    });

    const state = parseFen(fen);

    const pvGroups = new Map<number, typeof lines>();
    for (const info of lines) {
      const rank = info.multipv ?? 1;
      if (!pvGroups.has(rank)) pvGroups.set(rank, []);
      pvGroups.get(rank)!.push(info);
    }

    const lineResults = Array.from(pvGroups.entries())
      .sort(([a], [b]) => a - b)
      .map(([rank, infos]) => {
        const best = infos[infos.length - 1]!;
        const pv = best.pv ?? [];
        const uci = pv[0] ?? "";
        const score = best.score
          ? best.score.type === "cp"
            ? best.score.value / 100
            : null
          : null;
        const mate = best.score?.type === "mate" ? best.score.value : null;
        return {
          uci,
          san: null as string | null,
          rank,
          score,
          mate,
          depth: best.depth ?? null,
          pv: pv.slice(0, 10),
        };
      });

    const bestMove = lineResults[0]?.uci ?? "";

    res.json({
      fen,
      bestMove,
      lines: lineResults,
      thinkingTimeMs: thinkingMs,
      turn: state.turn,
      isCheck: state.isCheck,
      isCheckmate: state.isCheckmate,
    });
  } catch (err) {
    req.log.error({ err }, "Analysis failed");
    res.status(500).json({ error: err instanceof Error ? err.message : "Analysis failed" });
  }
});

export default router;
