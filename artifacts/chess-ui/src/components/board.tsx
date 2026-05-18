import React from "react";
import { parseFen, PIECE_SYMBOLS, getSquareName } from "@/lib/chess-utils";
import { cn } from "@/lib/utils";

interface ChessBoardProps {
  fen: string;
  lastMove?: string | null;
  color?: 'w' | 'b';
}

export function ChessBoard({ fen, lastMove, color = 'w' }: ChessBoardProps) {
  const { grid } = parseFen(fen);
  
  // if playing black, we might want to flip the board
  const flipped = color === 'b';
  
  const displayGrid = flipped ? [...grid].reverse().map(row => [...row].reverse()) : grid;

  const lastMoveSource = lastMove ? lastMove.substring(0, 2) : null;
  const lastMoveDest = lastMove ? lastMove.substring(2, 4) : null;

  return (
    <div className="w-full max-w-[400px] aspect-square border-4 border-card rounded overflow-hidden shadow-xl grid grid-cols-8 grid-rows-8">
      {displayGrid.map((row: (string | null)[], rowIdx: number) => (
        row.map((piece: string | null, colIdx: number) => {
          const actualRow = flipped ? 7 - rowIdx : rowIdx;
          const actualCol = flipped ? 7 - colIdx : colIdx;
          
          const isLight = (actualRow + actualCol) % 2 === 0;
          const sqName = getSquareName(actualRow, actualCol);
          const isLastMove = sqName === lastMoveSource || sqName === lastMoveDest;
          
          return (
            <div 
              key={`${actualRow}-${actualCol}`} 
              className={cn(
                "flex items-center justify-center text-4xl select-none cursor-default transition-colors relative",
                isLight ? "chess-square-light" : "chess-square-dark",
                isLastMove && "chess-square-highlight"
              )}
            >
              {piece ? (
                <span className={cn(
                  "drop-shadow-sm",
                  piece === piece.toUpperCase() ? "text-white" : "text-black"
                )}>
                  {PIECE_SYMBOLS[piece]}
                </span>
              ) : null}
              {actualCol === 0 && (
                <span className="absolute top-0.5 left-0.5 text-[8px] font-mono opacity-30 pointer-events-none">
                  {8 - actualRow}
                </span>
              )}
              {actualRow === 7 && (
                <span className="absolute bottom-0.5 right-0.5 text-[8px] font-mono opacity-30 pointer-events-none">
                  {['a','b','c','d','e','f','g','h'][actualCol]}
                </span>
              )}
            </div>
          );
        })
      ))}
    </div>
  );
}
