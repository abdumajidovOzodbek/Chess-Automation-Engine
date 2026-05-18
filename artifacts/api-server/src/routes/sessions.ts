import { Router, type IRouter } from "express";
import {
  GetSessionParams,
  GetSessionStateParams,
  GetSessionMovesParams,
  GetSessionTimingParams,
  GetSessionPgnParams,
  StopSessionParams,
  CreateSessionBody,
} from "@workspace/api-zod";
import {
  listSessions,
  getSession,
  startSession,
  stopSession,
} from "../lib/chess-sessions.js";
import { uciToSan } from "@workspace/chess-research";

const router: IRouter = Router();

router.get("/sessions", (_req, res) => {
  const sessions = listSessions();
  const data = sessions.map((s) => ({
    id: s.id,
    status: s.status,
    url: s.url,
    color: s.color,
    startedAt: s.startedAt,
    endedAt: s.endedAt ?? null,
    moveCount: s.moveCount,
    result: s.result ?? null,
    currentFen: s.currentFen ?? null,
  }));
  res.json(data);
});

router.post("/sessions", async (req, res) => {
  const parsed = CreateSessionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const input = parsed.data;

  try {
    const record = await startSession({
      url: input.url,
      color: input.color as "w" | "b",
      username: input.username ?? null,
      password: input.password ?? null,
      depth: input.depth ?? null,
      movetime: input.movetime ?? null,
      moveDelayMs: input.moveDelayMs ?? null,
      moveJitterMs: input.moveJitterMs ?? null,
      headless: input.headless ?? null,
    });

    res.status(201).json({
      id: record.id,
      status: record.status,
      url: record.url,
      color: record.color,
      startedAt: record.startedAt,
      endedAt: record.endedAt ?? null,
      moveCount: record.moveCount,
      result: record.result ?? null,
      currentFen: record.currentFen ?? null,
      lastMove: record.lastMove ?? null,
      isCheck: record.isCheck ?? null,
      config: record.config,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to start session");
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to start session" });
  }
});

router.get("/sessions/:id", (req, res) => {
  const parsed = GetSessionParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const record = getSession(parsed.data.id);
  if (!record) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  res.json({
    id: record.id,
    status: record.status,
    url: record.url,
    color: record.color,
    startedAt: record.startedAt,
    endedAt: record.endedAt ?? null,
    moveCount: record.moveCount,
    result: record.result ?? null,
    currentFen: record.currentFen ?? null,
    lastMove: record.lastMove ?? null,
    isCheck: record.isCheck ?? null,
    config: record.config,
  });
});

router.delete("/sessions/:id", async (req, res) => {
  const parsed = StopSessionParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const record = await stopSession(parsed.data.id);
  if (!record) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  res.json({
    id: record.id,
    status: record.status,
    url: record.url,
    color: record.color,
    startedAt: record.startedAt,
    endedAt: record.endedAt ?? null,
    moveCount: record.moveCount,
    result: record.result ?? null,
    currentFen: record.currentFen ?? null,
    lastMove: record.lastMove ?? null,
    isCheck: record.isCheck ?? null,
    config: record.config,
  });
});

router.get("/sessions/:id/state", (req, res) => {
  const parsed = GetSessionStateParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const record = getSession(parsed.data.id);
  if (!record) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const state = record.lastBoardState;
  if (!state) {
    res.json({
      fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      turn: "w",
      moveNumber: 1,
      isCheck: false,
      isCheckmate: false,
      isStalemate: false,
      isDraw: false,
      lastMove: null,
      legalMoves: [],
    });
    return;
  }

  res.json({
    fen: state.fen,
    turn: state.turn,
    moveNumber: state.moveNumber,
    isCheck: state.isCheck,
    isCheckmate: state.isCheckmate,
    isStalemate: state.isStalemate,
    isDraw: state.isDraw,
    lastMove: record.lastMove ?? null,
    legalMoves: [],
  });
});

router.get("/sessions/:id/moves", (req, res) => {
  const parsed = GetSessionMovesParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const record = getSession(parsed.data.id);
  if (!record) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const moves = record.moves.map((m) => ({
    id: m.id,
    moveNumber: m.moveNumber,
    color: m.color,
    uci: m.uci,
    san: m.san,
    fen: m.fen,
    timestamp: m.timestamp,
    thinkingTimeMs: m.thinkingTimeMs,
    executionTimeMs: m.executionTimeMs,
    source: m.source,
    engineScore: m.engineMove?.score
      ? (m.engineMove.score.type === "cp"
        ? m.engineMove.score.value / 100
        : null)
      : null,
    engineDepth: m.engineMove?.depth ?? null,
    bestLine: m.engineMove?.pv ? m.engineMove.pv.slice(0, 5).join(" ") : null,
  }));

  res.json(moves);
});

router.get("/sessions/:id/timing", (req, res) => {
  const parsed = GetSessionTimingParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const record = getSession(parsed.data.id);
  if (!record) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const moves = record.moves;
  const totalMoves = moves.length;

  if (totalMoves === 0) {
    res.json({
      sessionId: record.id,
      totalMoves: 0,
      averageThinkingMs: 0,
      averageExecutionMs: 0,
      minThinkingMs: null,
      maxThinkingMs: null,
      p95ThinkingMs: null,
      medianThinkingMs: null,
      durationMs: record.endedAt ? record.endedAt - record.startedAt : null,
    });
    return;
  }

  const thinkTimes = moves.map((m) => m.thinkingTimeMs).sort((a, b) => a - b);
  const execTimes = moves.map((m) => m.executionTimeMs);

  const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
  const percentile = (sorted: number[], p: number) => {
    const idx = Math.floor((p / 100) * sorted.length);
    return sorted[Math.min(idx, sorted.length - 1)] ?? null;
  };

  res.json({
    sessionId: record.id,
    totalMoves,
    averageThinkingMs: avg(thinkTimes),
    averageExecutionMs: avg(execTimes),
    minThinkingMs: thinkTimes[0] ?? null,
    maxThinkingMs: thinkTimes[thinkTimes.length - 1] ?? null,
    p95ThinkingMs: percentile(thinkTimes, 95),
    medianThinkingMs: percentile(thinkTimes, 50),
    durationMs: record.endedAt ? record.endedAt - record.startedAt : null,
  });
});

router.get("/sessions/:id/pgn", (req, res) => {
  const parsed = GetSessionPgnParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const record = getSession(parsed.data.id);
  if (!record) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const moves = record.moves;
  const lines: string[] = [];

  for (let i = 0; i < moves.length; i += 2) {
    const n = Math.floor(i / 2) + 1;
    const wMove = moves[i];
    const bMove = moves[i + 1];
    if (wMove && bMove) {
      lines.push(`${n}. ${wMove.san} ${bMove.san}`);
    } else if (wMove) {
      lines.push(`${n}. ${wMove.san}`);
    }
  }

  const result = record.result === "win"
    ? (record.color === "w" ? "1-0" : "0-1")
    : record.result === "loss"
    ? (record.color === "w" ? "0-1" : "1-0")
    : record.result === "draw"
    ? "1/2-1/2"
    : "*";

  const pgn = [
    `[Event "Chess Research Session"]`,
    `[Site "localhost"]`,
    `[Date "${new Date(record.startedAt).toISOString().slice(0, 10)}"]`,
    `[White "${record.color === "w" ? "Stockfish" : "Opponent"}"]`,
    `[Black "${record.color === "b" ? "Stockfish" : "Opponent"}"]`,
    `[Result "${result}"]`,
    "",
    lines.join(" ") + (lines.length ? " " : "") + result,
  ].join("\n");

  res.json({ pgn, sessionId: record.id });
});

export default router;
