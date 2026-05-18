import { Chess } from "chess.js";
import type { BoardState, BoardMove, Color, Square, PieceType } from "../types.ts";

export const STARTING_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export function parseFen(fen: string): BoardState {
  const chess = new Chess(fen);
  return buildBoardState(chess);
}

export function applyMove(state: BoardState, uci: string): BoardState {
  const chess = new Chess(state.fen);
  const from = uci.slice(0, 2) as Square;
  const to = uci.slice(2, 4) as Square;
  const promotion = uci.length === 5 ? (uci[4] as PieceType) : undefined;

  const result = chess.move({ from, to, promotion });
  if (!result) throw new Error(`Illegal move ${uci} on position ${state.fen}`);

  const move: BoardMove = {
    from,
    to,
    promotion,
    san: result.san,
    uci,
    timestamp: Date.now(),
  };

  return {
    ...buildBoardState(chess),
    history: [...state.history, move],
  };
}

export function buildBoardState(chess: Chess): BoardState {
  return {
    fen: chess.fen(),
    turn: chess.turn() as Color,
    moveNumber: chess.moveNumber(),
    isCheck: chess.inCheck(),
    isCheckmate: chess.isCheckmate(),
    isStalemate: chess.isStalemate(),
    isDraw: chess.isDraw(),
    history: [],
    extractedAt: Date.now(),
  };
}

export function fenToHash(fen: string): string {
  const parts = fen.split(" ");
  return [parts[0], parts[1], parts[2], parts[3]].join(" ");
}

export function movesToPgn(moves: BoardMove[]): string {
  const chess = new Chess();
  for (const move of moves) {
    try {
      chess.move({ from: move.from, to: move.to, promotion: move.promotion });
    } catch {
      break;
    }
  }
  return chess.pgn();
}

export function uciToSan(fen: string, uci: string): string | null {
  try {
    const chess = new Chess(fen);
    const from = uci.slice(0, 2) as Square;
    const to = uci.slice(2, 4) as Square;
    const promotion = uci.length === 5 ? (uci[4] as PieceType) : undefined;
    const result = chess.move({ from, to, promotion });
    return result?.san ?? null;
  } catch {
    return null;
  }
}

export function diffFens(prev: string, curr: string): { moved: boolean; uci: string | null } {
  if (prev === curr) return { moved: false, uci: null };

  try {
    const prevChess = new Chess(prev);
    const currChess = new Chess(curr);

    const prevBoard = prevChess.board();
    const currBoard = currChess.board();
    const FILES = "abcdefgh";

    const vacated: Square[] = [];
    const occupied: Square[] = [];

    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const sq = (FILES[f] + (8 - r)) as Square;
        const prevPiece = prevBoard[r][f];
        const currPiece = currBoard[r][f];
        if (prevPiece && !currPiece) vacated.push(sq);
        if (!prevPiece && currPiece) occupied.push(sq);
      }
    }

    if (vacated.length === 1 && occupied.length === 1) {
      return { moved: true, uci: vacated[0] + occupied[0] };
    }

    const moves = prevChess.moves({ verbose: true });
    const prevTurn = prevChess.turn() as Color;
    const currTurn = currChess.turn() as Color;

    if (prevTurn === currTurn) return { moved: false, uci: null };

    for (const move of moves) {
      const test = new Chess(prev);
      test.move(move);
      if (test.fen().split(" ").slice(0, 4).join(" ") === curr.split(" ").slice(0, 4).join(" ")) {
        const promo = move.promotion ? move.promotion : "";
        return { moved: true, uci: move.from + move.to + promo };
      }
    }

    return { moved: true, uci: null };
  } catch {
    return { moved: false, uci: null };
  }
}
