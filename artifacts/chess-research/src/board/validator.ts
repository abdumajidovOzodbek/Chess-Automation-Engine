import { Chess } from "chess.js";
import type { BoardState, BoardMove, Color, Square, PieceType } from "../types.ts";

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

export function validateMove(state: BoardState, uci: string): ValidationResult {
  if (!uci || uci.length < 4) {
    return { valid: false, reason: "Invalid UCI format" };
  }

  const from = uci.slice(0, 2) as Square;
  const to = uci.slice(2, 4) as Square;
  const promotion = uci.length === 5 ? (uci[4] as PieceType) : undefined;

  if (!isValidSquare(from) || !isValidSquare(to)) {
    return { valid: false, reason: `Invalid squares: ${from} -> ${to}` };
  }

  try {
    const chess = new Chess(state.fen);
    const result = chess.move({ from, to, promotion });
    if (!result) return { valid: false, reason: "Move rejected by chess engine" };
    return { valid: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { valid: false, reason: msg };
  }
}

export function validateFen(fen: string): ValidationResult {
  if (!fen || typeof fen !== "string") {
    return { valid: false, reason: "FEN must be a non-empty string" };
  }

  const parts = fen.trim().split(/\s+/);
  if (parts.length < 4) {
    return { valid: false, reason: `FEN must have at least 4 fields, got ${parts.length}` };
  }

  const [position, turn, castling, enPassant] = parts;

  const ranks = position.split("/");
  if (ranks.length !== 8) {
    return { valid: false, reason: `FEN position must have 8 ranks, got ${ranks.length}` };
  }

  for (const rank of ranks) {
    let count = 0;
    for (const ch of rank) {
      if (/\d/.test(ch)) {
        count += parseInt(ch, 10);
      } else if (/[pnbrqkPNBRQK]/.test(ch)) {
        count += 1;
      } else {
        return { valid: false, reason: `Invalid character in FEN rank: ${ch}` };
      }
    }
    if (count !== 8) {
      return { valid: false, reason: `FEN rank "${rank}" does not sum to 8 squares` };
    }
  }

  if (turn !== "w" && turn !== "b") {
    return { valid: false, reason: `Invalid turn indicator: ${turn}` };
  }

  if (!/^(-|[KQkq]+)$/.test(castling)) {
    return { valid: false, reason: `Invalid castling field: ${castling}` };
  }

  if (!/^(-|[a-h][36])$/.test(enPassant)) {
    return { valid: false, reason: `Invalid en passant field: ${enPassant}` };
  }

  try {
    new Chess(fen);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { valid: false, reason: `chess.js rejected FEN: ${msg}` };
  }

  return { valid: true };
}

export function getLegalMoves(state: BoardState): string[] {
  try {
    const chess = new Chess(state.fen);
    return chess.moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion ?? ""));
  } catch {
    return [];
  }
}

export function isGameOver(state: BoardState): boolean {
  return state.isCheckmate || state.isStalemate || state.isDraw;
}

export function getGameResult(state: BoardState): string {
  if (state.isCheckmate) {
    const winner: Color = state.turn === "w" ? "b" : "w";
    return winner === "w" ? "1-0" : "0-1";
  }
  if (state.isStalemate || state.isDraw) return "1/2-1/2";
  return "*";
}

export function stateConsistencyCheck(state: BoardState): ValidationResult {
  const fenResult = validateFen(state.fen);
  if (!fenResult.valid) return fenResult;

  try {
    const chess = new Chess(state.fen);
    if (chess.turn() !== state.turn) {
      return { valid: false, reason: `Turn mismatch: FEN says ${chess.turn()}, state says ${state.turn}` };
    }
    if (chess.moveNumber() !== state.moveNumber) {
      return { valid: false, reason: `Move number mismatch: FEN says ${chess.moveNumber()}, state says ${state.moveNumber}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { valid: false, reason: msg };
  }

  return { valid: true };
}

function isValidSquare(sq: string): sq is Square {
  return /^[a-h][1-8]$/.test(sq);
}
