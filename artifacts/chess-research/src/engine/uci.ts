import type { EngineMove, EngineScore, EngineOptions } from "../types.ts";

export interface UciInfo {
  depth?: number;
  seldepth?: number;
  time?: number;
  nodes?: number;
  score?: EngineScore;
  pv?: string[];
  multipv?: number;
  hashfull?: number;
  nps?: number;
  tbhits?: number;
  currmove?: string;
  currmovenumber?: number;
}

export interface UciBestMove {
  move: string;
  ponder?: string;
}

export type UciMessage =
  | { type: "id"; name?: string; author?: string }
  | { type: "uciok" }
  | { type: "readyok" }
  | { type: "bestmove"; data: UciBestMove }
  | { type: "info"; data: UciInfo }
  | { type: "option"; name: string; optionType: string; default?: string; min?: string; max?: string }
  | { type: "unknown"; raw: string };

export function parseUciMessage(line: string): UciMessage {
  const trimmed = line.trim();
  if (!trimmed) return { type: "unknown", raw: line };

  if (trimmed === "uciok") return { type: "uciok" };
  if (trimmed === "readyok") return { type: "readyok" };

  if (trimmed.startsWith("id ")) {
    const rest = trimmed.slice(3);
    if (rest.startsWith("name ")) return { type: "id", name: rest.slice(5) };
    if (rest.startsWith("author ")) return { type: "id", author: rest.slice(7) };
  }

  if (trimmed.startsWith("bestmove ")) {
    const parts = trimmed.slice(9).split(/\s+/);
    const move = parts[0];
    const ponder = parts[1] === "ponder" ? parts[2] : undefined;
    if (!move || move === "(none)") return { type: "bestmove", data: { move: "" } };
    return { type: "bestmove", data: { move, ponder } };
  }

  if (trimmed.startsWith("info ")) {
    return { type: "info", data: parseInfoLine(trimmed.slice(5)) };
  }

  if (trimmed.startsWith("option ")) {
    return parseOptionLine(trimmed.slice(7));
  }

  return { type: "unknown", raw: trimmed };
}

function parseInfoLine(line: string): UciInfo {
  const info: UciInfo = {};
  const tokens = line.split(/\s+/);
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];
    switch (token) {
      case "depth": info.depth = parseInt(tokens[++i], 10); break;
      case "seldepth": info.seldepth = parseInt(tokens[++i], 10); break;
      case "time": info.time = parseInt(tokens[++i], 10); break;
      case "nodes": info.nodes = parseInt(tokens[++i], 10); break;
      case "nps": info.nps = parseInt(tokens[++i], 10); break;
      case "hashfull": info.hashfull = parseInt(tokens[++i], 10); break;
      case "tbhits": info.tbhits = parseInt(tokens[++i], 10); break;
      case "multipv": info.multipv = parseInt(tokens[++i], 10); break;
      case "currmove": info.currmove = tokens[++i]; break;
      case "currmovenumber": info.currmovenumber = parseInt(tokens[++i], 10); break;
      case "score": {
        const scoreType = tokens[++i];
        const scoreValue = parseInt(tokens[++i], 10);
        if (scoreType === "cp" || scoreType === "mate") {
          info.score = { type: scoreType, value: scoreValue };
        }
        if (tokens[i + 1] === "lowerbound" || tokens[i + 1] === "upperbound") i++;
        break;
      }
      case "pv": {
        info.pv = [];
        while (++i < tokens.length) info.pv.push(tokens[i]);
        i = tokens.length;
        break;
      }
      default: break;
    }
    i++;
  }

  return info;
}

function parseOptionLine(line: string): UciMessage {
  const nameMatch = line.match(/name\s+(.+?)(?:\s+type|$)/);
  const typeMatch = line.match(/type\s+(\w+)/);
  const defaultMatch = line.match(/default\s+(.+?)(?:\s+min|\s+max|$)/);
  const minMatch = line.match(/min\s+(\S+)/);
  const maxMatch = line.match(/max\s+(\S+)/);

  return {
    type: "option",
    name: nameMatch?.[1]?.trim() ?? "",
    optionType: typeMatch?.[1] ?? "string",
    default: defaultMatch?.[1]?.trim(),
    min: minMatch?.[1],
    max: maxMatch?.[1],
  };
}

export function buildUciCommand(options: EngineOptions): string[] {
  const cmds: string[] = [];
  if (options.threads !== undefined) cmds.push(`setoption name Threads value ${options.threads}`);
  if (options.hashMB !== undefined) cmds.push(`setoption name Hash value ${options.hashMB}`);
  if (options.multiPV !== undefined) cmds.push(`setoption name MultiPV value ${options.multiPV}`);
  if (options.skillLevel !== undefined) cmds.push(`setoption name Skill Level value ${options.skillLevel}`);
  return cmds;
}

export function buildGoCommand(options: EngineOptions): string {
  const parts = ["go"];
  if (options.depth !== undefined) parts.push("depth", String(options.depth));
  else if (options.movetime !== undefined) parts.push("movetime", String(options.movetime));
  else if (options.nodes !== undefined) parts.push("nodes", String(options.nodes));
  else parts.push("movetime", "3000");
  return parts.join(" ");
}

export function uciToEngineMove(uci: string, info?: UciInfo): EngineMove | null {
  if (!uci || uci.length < 4) return null;
  return {
    uci,
    from: uci.slice(0, 2) as EngineMove["from"],
    to: uci.slice(2, 4) as EngineMove["to"],
    promotion: uci.length === 5 ? (uci[4] as EngineMove["promotion"]) : undefined,
    score: info?.score,
    depth: info?.depth,
    nodes: info?.nodes,
    time: info?.time,
    pv: info?.pv,
  };
}
