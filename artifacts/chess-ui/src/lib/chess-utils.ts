export function parseFen(fen: string) {
  if (!fen) return { grid: Array(8).fill(Array(8).fill("")), turn: 'w' };
  
  const parts = fen.split(" ");
  const boardPart = parts[0];
  const turn = parts[1] || 'w';
  const rows = boardPart.split("/");
  const grid: string[][] = [];
  
  for (const row of rows) {
    const gridRow: string[] = [];
    for (const char of row) {
      if (/\d/.test(char)) {
        const emptyCount = parseInt(char, 10);
        for (let i = 0; i < emptyCount; i++) {
          gridRow.push("");
        }
      } else {
        gridRow.push(char);
      }
    }
    grid.push(gridRow);
  }
  return { grid, turn };
}

export const PIECE_SYMBOLS: Record<string, string> = {
  'K': '♔', 'Q': '♕', 'R': '♖', 'B': '♗', 'N': '♘', 'P': '♙',
  'k': '♚', 'q': '♛', 'r': '♜', 'b': '♝', 'n': '♞', 'p': '♟'
};

export function getSquareName(rowIdx: number, colIdx: number): string {
  const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const rank = 8 - rowIdx;
  const file = files[colIdx];
  return `${file}${rank}`;
}
