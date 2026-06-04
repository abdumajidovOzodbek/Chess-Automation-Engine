// inject.js — runs in the page's MAIN world for chess.com
//
// chess.com uses a <wc-chess-board> custom element. Pieces are <div class="piece wp square-52">
// where:
//   - First word after "piece": piece code (wp/wn/wb/wr/wq/wk/bp/bn/bb/br/bq/bk)
//   - "square-NN" where NN = file+rank (12 = a2, 88 = h8)
//
// Some chess.com pages also use SVG-based boards but the class scheme is similar.

(function () {
  'use strict';

  window.addEventListener('CHESS_ADVISOR_REQUEST', function (e) {
    const wantDiag = e.detail && e.detail.diagnostic;
    try {
      const result = wantDiag ? collectDiagnostics() : readGameState();
      window.dispatchEvent(new CustomEvent('CHESS_ADVISOR_RESPONSE', { detail: result }));
    } catch (err) {
      window.dispatchEvent(new CustomEvent('CHESS_ADVISOR_RESPONSE', { detail: { error: String(err), stack: err && err.stack } }));
    }
  });

  // ── BOARD ELEMENT ──────────────────────────────────────────────────────────
  function findBoardElement() {
    // Preferred: chess.com's custom element
    let board = document.querySelector('wc-chess-board, chess-board, cg-board');
    if (board) {
      const r = board.getBoundingClientRect();
      if (r.width > 100) {
        return {
          el: board, left: r.left, top: r.top, width: r.width, height: r.height,
          tag: board.tagName, cls: (board.className || '').toString().substring(0, 80),
        };
      }
    }

    // Fallback: largest perfectly-square element on screen
    const all = document.querySelectorAll('*');
    let best = null, bestArea = 0;
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      const r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 200) continue;
      if (Math.abs(r.width - r.height) > Math.min(r.width, r.height) * 0.02) continue;
      if (r.bottom < 0 || r.top > window.innerHeight) continue;
      const area = r.width * r.height;
      if (area > bestArea) {
        bestArea = area;
        best = { el, left: r.left, top: r.top, width: r.width, height: r.height,
                 tag: el.tagName, cls: (el.className || '').toString().substring(0, 80) };
      }
    }
    if (!best) return { error: 'no chessboard found' };
    return best;
  }

  // ── ORIENTATION ────────────────────────────────────────────────────────────
  function detectOrientation(board) {
    // Method 1: <wc-chess-board flipped> attribute
    if (board.hasAttribute && board.hasAttribute('flipped')) return 'black';

    // Method 2: chess.com data-orientation attr (older)
    const o = board.getAttribute && board.getAttribute('orientation');
    if (o === 'black' || o === 'b') return 'black';
    if (o === 'white' || o === 'w') return 'white';

    // Method 3: cg-style class
    const cls = ((board.className || '') + '').toLowerCase();
    if (cls.includes('orientation-black') || cls.includes('flipped')) return 'black';
    if (cls.includes('orientation-white')) return 'white';

    // Method 4: examine coordinate labels
    // chess.com puts 'a1' label at bottom-left when white-oriented
    return null; // unknown — caller will infer from king positions
  }

  // ── PIECE → SQUARE MAPPING ─────────────────────────────────────────────────
  // chess.com classes: "piece wp square-12" → file 1 (a), rank 2 → a2
  // Returns null if not a chess.com style piece.
  function readChessComPiece(el) {
    const cls = ((el.className || '') + ' ' + (el.getAttribute('class') || '')).toLowerCase();
    // Find piece code: w[pnbrqk] or b[pnbrqk]
    const pieceMatch = cls.match(/\b([wb])([pnbrqk])\b/);
    if (!pieceMatch) return null;
    const color = pieceMatch[1];
    const type = pieceMatch[2];
    const piece = color === 'w' ? type.toUpperCase() : type;

    // Find square: square-NN (NN is file*10 + rank, e.g. 12 = a2, 88 = h8)
    const sqMatch = cls.match(/square-(\d)(\d)/);
    if (!sqMatch) return null;
    const file = parseInt(sqMatch[1], 10) - 1; // 1..8 → 0..7
    const rank = parseInt(sqMatch[2], 10) - 1;
    if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;

    return { piece, file, rank };
  }

  // ── DOM-BASED FEN EXTRACTOR ────────────────────────────────────────────────
  function extractFenFromDom(boardInfo) {
    const board = boardInfo.el;
    const rect = { left: boardInfo.left, top: boardInfo.top, width: boardInfo.width, height: boardInfo.height };

    // Try chess.com-style square classes first (most reliable)
    const chessComBoard = {};
    const pieceEls = board.querySelectorAll('.piece, [class*="piece"]');
    let chessComPieces = 0;
    for (const el of pieceEls) {
      const info = readChessComPiece(el);
      if (info) {
        chessComBoard[info.file + ',' + info.rank] = info.piece;
        chessComPieces++;
      }
    }

    if (chessComPieces >= 2) {
      // chess.com square-NN system uses board coordinates directly:
      // file 0 = a, rank 0 = 1, rank 7 = 8
      // Build FEN from rank 8 down to rank 1
      const ranks = [];
      for (let rank = 7; rank >= 0; rank--) {
        let rankStr = '';
        let empty = 0;
        for (let file = 0; file < 8; file++) {
          const piece = chessComBoard[file + ',' + rank];
          if (piece) {
            if (empty > 0) { rankStr += empty; empty = 0; }
            rankStr += piece;
          } else {
            empty++;
          }
        }
        if (empty > 0) rankStr += empty;
        ranks.push(rankStr);
      }
      const fenPos = ranks.join('/');

      // Detect orientation: from board attrs first, then king position fallback
      let orientation = detectOrientation(board);
      if (!orientation) {
        // White king starts at e1 (rank 0). If we see a white king at rank 0, board is white-oriented.
        for (const [coord, p] of Object.entries(chessComBoard)) {
          if (p === 'K') {
            const [, rank] = coord.split(',').map(Number);
            orientation = rank <= 1 ? 'white' : 'black';
            break;
          }
        }
        if (!orientation) orientation = 'white';
      }

      return { fenPos, flipped: orientation === 'black', pieceCount: chessComPieces, source: 'chesscom-square' };
    }

    // Fallback: chessground-style (positional)
    return extractFenFromPositions(boardInfo);
  }

  // Positional fallback — for boards without square-NN classes
  function extractFenFromPositions(boardInfo) {
    const board = boardInfo.el;
    const rect = { left: boardInfo.left, top: boardInfo.top, width: boardInfo.width, height: boardInfo.height };
    const sqW = rect.width / 8;
    const sqH = rect.height / 8;

    const boardCls = ((board.className || '') + '').toLowerCase();
    let flipped;
    if (boardCls.includes('orientation-black') || boardCls.includes('flipped')) flipped = true;
    else if (boardCls.includes('orientation-white')) flipped = false;
    else if (board.hasAttribute && board.hasAttribute('flipped')) flipped = true;
    else flipped = null;

    const pieceEls = board.querySelectorAll('piece, [class*="piece"], [class*="Piece"]');
    if (pieceEls.length === 0) return { error: 'no piece elements found' };

    const boardMap = {};
    let whiteKingRow = null, blackKingRow = null;
    for (const pieceEl of pieceEls) {
      const piece = identifyPieceByClass(pieceEl);
      if (!piece) continue;
      const r = pieceEl.getBoundingClientRect();
      if (r.width === 0) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const col = Math.floor((cx - rect.left) / sqW);
      const row = Math.floor((cy - rect.top) / sqH);
      if (col < 0 || col > 7 || row < 0 || row > 7) continue;
      boardMap[col + ',' + row] = piece;
      if (piece === 'K') whiteKingRow = row;
      if (piece === 'k') blackKingRow = row;
    }

    if (Object.keys(boardMap).length === 0) return { error: 'pieces detected but no positions' };

    if (flipped === null) {
      if (whiteKingRow !== null) flipped = whiteKingRow < 4;
      else if (blackKingRow !== null) flipped = blackKingRow >= 4;
      else flipped = false;
    }

    const ranks = [];
    for (let fenRankIdx = 0; fenRankIdx < 8; fenRankIdx++) {
      const displayRow = flipped ? 7 - fenRankIdx : fenRankIdx;
      let rankStr = '';
      let empty = 0;
      for (let fenFile = 0; fenFile < 8; fenFile++) {
        const displayCol = flipped ? 7 - fenFile : fenFile;
        const piece = boardMap[displayCol + ',' + displayRow];
        if (piece) {
          if (empty > 0) { rankStr += empty; empty = 0; }
          rankStr += piece;
        } else {
          empty++;
        }
      }
      if (empty > 0) rankStr += empty;
      ranks.push(rankStr);
    }

    return { fenPos: ranks.join('/'), flipped, pieceCount: pieceEls.length, source: 'positional' };
  }

  function identifyPieceByClass(el) {
    const cls = ((el.className || '') + ' ' + (el.getAttribute('class') || '')).toLowerCase();
    // chess.com: wp/wn/.../bk
    const m = cls.match(/\b([wb])([pnbrqk])\b/);
    if (m) return m[1] === 'w' ? m[2].toUpperCase() : m[2];
    // chessground: "white pawn"
    let color = null, type = null;
    if (cls.includes('white')) color = 'w';
    else if (cls.includes('black')) color = 'b';
    if (cls.includes('king')) type = 'k';
    else if (cls.includes('queen')) type = 'q';
    else if (cls.includes('rook')) type = 'r';
    else if (cls.includes('bishop')) type = 'b';
    else if (cls.includes('knight')) type = 'n';
    else if (cls.includes('pawn')) type = 'p';
    if (color && type) return color === 'w' ? type.toUpperCase() : type;
    return null;
  }

  // ── CLOCK READER ───────────────────────────────────────────────────────────
  function readClocks() {
    try {
      const re = /^\s*(\d{1,2}):(\d{2})(?:\.\d)?\s*$/;
      const found = [];
      const all = document.querySelectorAll('div, span');
      for (const el of all) {
        if (el.children.length > 0) continue;
        const t = (el.textContent || '').trim();
        const m = t.match(re);
        if (!m) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 14) continue;
        if (r.top < 0 || r.top > window.innerHeight) continue;
        const minutes = parseInt(m[1], 10);
        const seconds = parseInt(m[2], 10);
        if (minutes > 99) continue;
        const cls = ((el.className || '') + '').toLowerCase();
        // chess.com clocks usually have "clock" in their class
        const score = cls.includes('clock') ? 1000 : 0;
        found.push({
          ms: (minutes * 60 + seconds) * 1000,
          rect: r,
          fontSize: parseFloat(getComputedStyle(el).fontSize) || 0,
          score,
        });
      }
      // Prefer clock-classed elements, then largest font
      found.sort((a, b) => (b.score - a.score) || (b.fontSize - a.fontSize));
      const top = found.slice(0, 2);
      if (top.length < 2) return null;
      top.sort((a, b) => a.rect.top - b.rect.top);
      return { topMs: top[0].ms, bottomMs: top[1].ms };
    } catch (e) { return null; }
  }

  // ── DIAGNOSTICS ────────────────────────────────────────────────────────────
  function collectDiagnostics() {
    const out = {
      diagnostic: true,
      url: location.href,
      visibleBoard: null,
      pieceCount: 0,
      pieceSamples: [],
      domFen: null,
      clocks: null,
    };

    const boardInfo = findBoardElement();
    if (boardInfo.error) {
      out.boardError = boardInfo.error;
      return out;
    }
    out.visibleBoard = {
      tag: boardInfo.tag,
      cls: boardInfo.cls,
      rect: { left: Math.round(boardInfo.left), top: Math.round(boardInfo.top),
              w: Math.round(boardInfo.width), h: Math.round(boardInfo.height) },
    };

    const pieceEls = boardInfo.el.querySelectorAll('.piece, [class*="piece"]');
    out.pieceCount = pieceEls.length;
    for (let i = 0; i < Math.min(8, pieceEls.length); i++) {
      const p = pieceEls[i];
      const cc = readChessComPiece(p);
      out.pieceSamples.push({
        tag: p.tagName,
        cls: (p.className || '').toString().substring(0, 80),
        chesscom: cc ? `${cc.piece}@(${cc.file},${cc.rank})` : null,
        legacy: identifyPieceByClass(p),
      });
    }

    out.domFen = extractFenFromDom(boardInfo);
    out.clocks = readClocks();
    return out;
  }

  // ── REAL MODE ──────────────────────────────────────────────────────────────
  function readGameState() {
    const boardInfo = findBoardElement();
    if (boardInfo.error) return boardInfo;

    const fenResult = extractFenFromDom(boardInfo);
    if (fenResult.error) return { ...fenResult, board: boardInfo };

    const orientation = fenResult.flipped ? 'black' : 'white';
    const turn = orientation === 'black' ? 'b' : 'w';
    const fen = `${fenResult.fenPos} ${turn} KQkq - 0 1`;
    const clocks = readClocks();

    return {
      fen,
      orientation,
      flipped: fenResult.flipped,
      boardLeft: boardInfo.left,
      boardTop: boardInfo.top,
      boardWidth: boardInfo.width,
      boardHeight: boardInfo.height,
      boardClass: boardInfo.cls,
      method: fenResult.source,
      pieceCount: fenResult.pieceCount,
      clocks,
    };
  }
})();
