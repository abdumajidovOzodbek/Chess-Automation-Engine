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

  // Move execution for chess.com — tries multiple approaches to make moves
  window.addEventListener('CHESS_ADVISOR_CG_MOVE', function (e) {
    const reqId = e.detail && e.detail.reqId;
    const uci = e.detail && e.detail.uci;
    let ok = false;
    let pieceMoved = false;
    try {
      const srcBefore = readSourcePiece(uci);
      ok = applyMoveViaChessboard(uci);
      const srcAfter = readSourcePiece(uci);
      pieceMoved = (srcBefore && !srcAfter) || (srcBefore !== srcAfter);
    } catch (err) { /* ignore */ }
    window.dispatchEvent(new CustomEvent('CHESS_ADVISOR_CG_MOVE_RESPONSE', { detail: { reqId, ok, pieceMoved } }));
  });

  // Find precise screen coordinates of the from/to squares for chess.com
  window.addEventListener('CHESS_ADVISOR_SQ_QUERY', function (e) {
    const reqId = e.detail && e.detail.reqId;
    const uci = e.detail && e.detail.uci;
    let result = { reqId, from: null, to: null, method: 'none' };
    try {
      const board = document.querySelector('wc-chess-board, chess-board, cg-board, .cg-board, div.cg-board');
      if (!board || !uci || uci.length < 4) {
        window.dispatchEvent(new CustomEvent('CHESS_ADVISOR_SQ_RESPONSE', { detail: result }));
        return;
      }
      const rect = board.getBoundingClientRect();
      if (rect.width < 100 || rect.height < 100) {
        result.error = 'board not rendered';
        window.dispatchEvent(new CustomEvent('CHESS_ADVISOR_SQ_RESPONSE', { detail: result }));
        return;
      }
      const sqW = rect.width / 8;
      const sqH = rect.height / 8;

      const cls = (board.className || '').toString().toLowerCase();
      const flipped = cls.includes('orientation-black') || cls.includes('flipped') || board.hasAttribute('flipped');

      const fromFile = uci.charCodeAt(0) - 97;
      const fromRank = parseInt(uci[1], 10) - 1;
      const toFile = uci.charCodeAt(2) - 97;
      const toRank = parseInt(uci[3], 10) - 1;

      const fromCol = flipped ? 7 - fromFile : fromFile;
      const fromRow = flipped ? fromRank : 7 - fromRank;
      const toCol = flipped ? 7 - toFile : toFile;
      const toRow = flipped ? toRank : 7 - toRank;

      const gridFrom = { x: rect.left + (fromCol + 0.5) * sqW, y: rect.top + (fromRow + 0.5) * sqH };
      const gridTo = { x: rect.left + (toCol + 0.5) * sqW, y: rect.top + (toRow + 0.5) * sqH };

      // Find the piece element at the source using actual rendered center
      const pieces = board.querySelectorAll('piece, .piece, [class*="piece"]');
      let bestSrc = null, bestSrcDist = sqW * 0.5;
      let bestDst = null, bestDstDist = sqW * 0.5;
      for (const p of pieces) {
        const r = p.getBoundingClientRect();
        if (r.width < 5) continue;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const dSrc = Math.hypot(cx - gridFrom.x, cy - gridFrom.y);
        if (dSrc < bestSrcDist) { bestSrcDist = dSrc; bestSrc = { x: cx, y: cy }; }
        const dDst = Math.hypot(cx - gridTo.x, cy - gridTo.y);
        if (dDst < bestDstDist) { bestDstDist = dDst; bestDst = { x: cx, y: cy }; }
      }

      result.from = bestSrc || gridFrom;
      result.to = bestDst || gridTo;
      result.method = (bestSrc && bestDst) ? 'piece-piece' : (bestSrc ? 'piece-grid' : 'grid');
    } catch (err) {
      result.error = String(err);
    }
    window.dispatchEvent(new CustomEvent('CHESS_ADVISOR_SQ_RESPONSE', { detail: result }));
  });

  // Read what piece is at the source square of a UCI move (using DOM piece scan)
  function readSourcePiece(uci) {
    if (!uci || uci.length < 4) return null;
    try {
      const board = document.querySelector('wc-chess-board, chess-board, cg-board, .cg-board, div.cg-board');
      if (!board) return null;
      const rect = board.getBoundingClientRect();
      const pieces = board.querySelectorAll('piece, .piece, [class*="piece"]');
      const file = uci.charCodeAt(0) - 97;
      const rank = parseInt(uci[1], 10) - 1;

      // Detect orientation
      const cls = (board.className || '').toString().toLowerCase();
      const flipped = cls.includes('orientation-black') || cls.includes('flipped') || board.hasAttribute('flipped');
      const col = flipped ? 7 - file : file;
      const row = flipped ? rank : 7 - rank;
      const sqW = rect.width / 8;
      const sqH = rect.height / 8;
      const targetX = rect.left + (col + 0.5) * sqW;
      const targetY = rect.top + (row + 0.5) * sqH;

      for (const p of pieces) {
        const r = p.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        if (Math.abs(cx - targetX) < sqW * 0.4 && Math.abs(cy - targetY) < sqH * 0.4) {
          return (p.className || '').toString();
        }
      }
      return null;
    } catch (e) { return null; }
  }

  // Apply move on chess.com board using multiple strategies
  function applyMoveViaChessboard(uci) {
    if (!uci || uci.length < 4) return false;
    
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promo = uci[4];

    // Strategy 1: Try chessground API if available
    try {
      const cgBoard = document.querySelector('cg-board, .cg-board');
      if (cgBoard && window.chessground) {
        const cg = window.chessground;
        if (typeof cg.move === 'function') {
          cg.move(from, to);
          return true;
        }
        if (typeof cg.selectSquare === 'function') {
          cg.selectSquare(from);
          cg.selectSquare(to);
          return true;
        }
      }
    } catch (e) { /* try next */ }

    // Strategy 2: chess.com game controller API
    try {
      // chess.com exposes window.chessboard or a game controller
      if (window.chessboard) {
        const cb = window.chessboard;
        if (typeof cb.makeMove === 'function') {
          cb.makeMove(from, to, promo);
          return true;
        }
        if (typeof cb.move === 'function') {
          cb.move(from + to + (promo || ''));
          return true;
        }
      }
    } catch (e) { /* try next */ }

    // Strategy 3: Look for game controller in common locations
    try {
      if (window.gameController || window.game) {
        const gc = window.gameController || window.game;
        const methods = ['makeMove', 'move', 'playMove', 'userMove', 'doMove'];
        for (const m of methods) {
          if (typeof gc[m] === 'function') {
            try {
              gc[m](from, to, promo);
              return true;
            } catch (e1) {
              try {
                gc[m]({ from, to, promotion: promo });
                return true;
              } catch (e2) {
                try {
                  gc[m](from + to + (promo || ''));
                  return true;
                } catch (e3) { /* continue */ }
              }
            }
          }
        }
      }
    } catch (e) { /* try next */ }

    // Strategy 4: Simulate click events on the squares
    try {
      const board = document.querySelector('wc-chess-board, chess-board, .cg-board');
      if (board) {
        const fromSq = board.querySelector(`[data-square="${from}"], .square-${from.charCodeAt(0) - 96}${from[1]}`);
        const toSq = board.querySelector(`[data-square="${to}"], .square-${to.charCodeAt(0) - 96}${to[1]}`);
        if (fromSq && toSq) {
          fromSq.click();
          setTimeout(() => toSq.click(), 10);
          return true;
        }
      }
    } catch (e) { /* failed */ }

    return false;
  }

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
