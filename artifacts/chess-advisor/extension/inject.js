// inject.js — runs in the page's MAIN world
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

  // Move execution via chessground's own API — the same path the platform uses
  // when the user clicks. Synthetic mouse events get isTrusted=false and are often
  // ignored by chessground; this bypasses that entirely.
  window.addEventListener('CHESS_ADVISOR_CG_MOVE', function (e) {
    const reqId = e.detail && e.detail.reqId;
    const uci = e.detail && e.detail.uci;
    let ok = false;
    let pieceMoved = false;
    try {
      // Capture source piece BEFORE move
      const srcBefore = readSourcePiece(uci);
      ok = applyMoveViaChessground(uci);
      // Verify the source square actually got cleared (piece really moved)
      const srcAfter = readSourcePiece(uci);
      pieceMoved = (srcBefore && !srcAfter) || (srcBefore !== srcAfter);
    } catch (err) { /* ignore */ }
    window.dispatchEvent(new CustomEvent('CHESS_ADVISOR_CG_MOVE_RESPONSE', { detail: { reqId, ok, pieceMoved } }));
  });

  // Find precise screen coordinates of the from/to squares using actual DOM.
  // The piece element's bounding rect IS where chessground/chessfriends thinks
  // the square is. Computing from a board rect + grid math can be off by half
  // a square if the board has padding, borders, or transforms.
  window.addEventListener('CHESS_ADVISOR_SQ_QUERY', function (e) {
    const reqId = e.detail && e.detail.reqId;
    const uci = e.detail && e.detail.uci;
    let result = { reqId, from: null, to: null, method: 'none' };
    try {
      const board = document.querySelector('div.cg-board, cg-board, .cg-board');
      if (!board || !uci || uci.length < 4) {
        window.dispatchEvent(new CustomEvent('CHESS_ADVISOR_SQ_RESPONSE', { detail: result }));
        return;
      }
      const rect = board.getBoundingClientRect();
      // Reject zero-size boards (game not yet rendered)
      if (rect.width < 100 || rect.height < 100) {
        result.error = 'board not rendered';
        window.dispatchEvent(new CustomEvent('CHESS_ADVISOR_SQ_RESPONSE', { detail: result }));
        return;
      }
      const sqW = rect.width / 8;
      const sqH = rect.height / 8;

      const cls = (board.className || '').toString().toLowerCase();
      const flipped = cls.includes('orientation-black') || cls.includes('flipped');

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

      // Find the piece element at the source — use its actual rendered center.
      const pieces = board.querySelectorAll('piece, [class*="piece"]');
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

  // Read what piece is at the source square of a UCI move (using DOM piece scan).
  function readSourcePiece(uci) {
    if (!uci || uci.length < 4) return null;
    try {
      const board = document.querySelector('.cg-board, cg-board, div.cg-board');
      if (!board) return null;
      const rect = board.getBoundingClientRect();
      const pieces = board.querySelectorAll('piece, [class*="piece"]');
      const file = uci.charCodeAt(0) - 97;
      const rank = parseInt(uci[1], 10) - 1;

      // Detect orientation from class
      const cls = (board.className || '').toString().toLowerCase();
      const flipped = cls.includes('orientation-black') || cls.includes('flipped');
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

  function applyMoveViaChessground(uci) {
    if (!uci || uci.length < 4) return false;
    if (!window.Ext || !window.Ext.ComponentQuery) return false;

    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promo = uci[4];

    const panels = Ext.ComponentQuery.query('adxgameboardpanel') || [];
    for (const p of panels) {
      let cg = null;
      try { cg = p.getChessGround && p.getChessGround(); } catch (e) {}
      if (!cg) continue;

      // Approach 1: call chessground.move(orig, dest) directly.
      // chessground exposes this as cg.move on its public API.
      try {
        if (typeof cg.move === 'function') {
          cg.move(from, to);
          // chessground.move only updates the visual state; we also need to
          // notify the platform's "move played" handler. chessground accepts
          // a `playMove` or fires `events.move` from user input. The simplest
          // way to trigger the platform's submission is to invoke the panel's
          // own move-submission method if exposed.
          tryPanelSubmit(p, from, to, promo);
          return true;
        }
      } catch (e) { /* try next */ }

      // Approach 2: panel-level methods (chessfriends-specific)
      // adxgameboardpanel often has methods like userMove/playMove/sendMove.
      const panelMoveMethods = ['userMove', 'playMove', 'sendMove', 'doMove', 'makeMove', 'submitMove'];
      for (const m of panelMoveMethods) {
        try {
          if (typeof p[m] === 'function') {
            // Try multiple call signatures
            let r;
            try { r = p[m](from, to, promo); } catch (e1) {
              try { r = p[m]({ from, to, promotion: promo }); } catch (e2) {
                try { r = p[m](from + to + (promo || '')); } catch (e3) {}
              }
            }
            if (r !== undefined) return true;
          }
        } catch (e) { /* try next method */ }
      }

      // Approach 3: trigger chessground's selectSquare twice
      try {
        if (typeof cg.selectSquare === 'function') {
          cg.selectSquare(from);
          cg.selectSquare(to);
          return true;
        }
      } catch (e) {}
    }
    return false;
  }

  function tryPanelSubmit(panel, from, to, promo) {
    // Notify the platform that a user move was played. This re-uses chessground's
    // event hooks if they exist.
    try {
      const cg = panel.getChessGround && panel.getChessGround();
      if (cg && cg.state && cg.state.movable && typeof cg.state.movable.events === 'object') {
        const handler = cg.state.movable.events.after;
        if (typeof handler === 'function') {
          // Build minimal metadata that matches chessground's expected callback
          handler(from, to, { ctrlKey: false, premove: false });
        }
      }
    } catch (e) {}
  }

  // ── BOARD ELEMENT FINDER ───────────────────────────────────────────────────
  function findBoardElement() {
    // We want the actual chess pieces container, ideally cg-board or similar.
    // Strategy: find the largest perfectly-square element, then search inside it
    // for the inner pieces container.
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
                 tag: el.tagName, cls: (el.className || '').toString().substring(0, 100) };
      }
    }
    if (!best) return { error: 'no square element on page' };

    // Try to drill down into the actual pieces container inside this wrapper
    const innerCandidates = ['cg-board', '.cg-board', '.cg-wrap cg-board', 'cg-container > cg-board'];
    for (const sel of innerCandidates) {
      try {
        const inner = best.el.querySelector(sel);
        if (inner) {
          const ir = inner.getBoundingClientRect();
          if (ir.width > 100) {
            best.el = inner;
            best.left = ir.left;
            best.top = ir.top;
            best.width = ir.width;
            best.height = ir.height;
            best.tag = inner.tagName;
            best.cls = (inner.className || '').toString().substring(0, 100);
            break;
          }
        }
      } catch (e) {}
    }

    return best;
  }

  // ── DOM-BASED FEN EXTRACTOR ────────────────────────────────────────────────
  function extractFenFromDom(boardInfo) {
    const board = boardInfo.el;
    const rect = { left: boardInfo.left, top: boardInfo.top, width: boardInfo.width, height: boardInfo.height };
    const sqW = rect.width / 8;
    const sqH = rect.height / 8;

    // Detect orientation directly from the cg-board class (most reliable)
    const boardClass = (board.className || '').toString().toLowerCase();
    let flipped;
    if (boardClass.includes('orientation-black')) flipped = true;
    else if (boardClass.includes('orientation-white')) flipped = false;
    else flipped = null; // will fall back to king detection

    const pieceEls = board.querySelectorAll('piece, [class*="piece"], [class*="Piece"]');
    if (pieceEls.length === 0) {
      return { error: 'no piece elements found inside board' };
    }

    // Build piece map: "displayCol,displayRow" -> piece char
    const boardMap = {};
    let whiteKingRow = null, blackKingRow = null;

    for (const pieceEl of pieceEls) {
      const piece = identifyPiece(pieceEl);
      if (!piece) continue;
      const pos = getPiecePosition(pieceEl, rect, sqW, sqH);
      if (!pos) continue;
      boardMap[pos.col + ',' + pos.row] = piece;
      if (piece === 'K') whiteKingRow = pos.row;
      if (piece === 'k') blackKingRow = pos.row;
    }

    if (Object.keys(boardMap).length === 0) {
      return { error: 'pieces detected but none placed on a square' };
    }

    // Fallback orientation detection if class didn't tell us
    if (flipped === null) {
      if (whiteKingRow !== null) flipped = whiteKingRow < 4;
      else if (blackKingRow !== null) flipped = blackKingRow >= 4;
      else flipped = false;
    }

    // Build FEN: iterate ranks from rank 8 down to rank 1, files a to h.
    //
    // Display coordinate mapping:
    //   not flipped: displayRow 0 = rank 8 (top of screen has black)
    //                displayCol 0 = file a (left of screen)
    //   flipped:     displayRow 0 = rank 1 (top of screen has white)
    //                displayCol 0 = file h (left of screen)
    const ranks = [];
    for (let fenRankIdx = 0; fenRankIdx < 8; fenRankIdx++) {
      // fenRankIdx 0 = rank 8, fenRankIdx 7 = rank 1
      const displayRow = flipped ? 7 - fenRankIdx : fenRankIdx;
      let rankStr = '';
      let empty = 0;
      for (let fenFile = 0; fenFile < 8; fenFile++) {
        // fenFile 0 = file a, fenFile 7 = file h
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

    const fenPos = ranks.join('/');

    // Sanity check: a valid position has exactly 1 white king and 1 black king,
    // and at most 32 pieces total. Reject corrupted reads (mid-animation duplicates).
    let whiteKings = 0, blackKings = 0, totalPieces = 0;
    for (const ch of fenPos) {
      if (ch === 'K') { whiteKings++; totalPieces++; }
      else if (ch === 'k') { blackKings++; totalPieces++; }
      else if ('PNBRQpnbrq'.indexOf(ch) >= 0) totalPieces++;
    }
    if (whiteKings !== 1 || blackKings !== 1 || totalPieces > 32) {
      return { error: 'corrupt FEN (kings=' + whiteKings + '/' + blackKings + ', pieces=' + totalPieces + ')' };
    }

    return { fenPos, flipped, pieceCount: pieceEls.length };
  }

  function identifyPiece(el) {
    const cls = ((el.className || '').toString() + ' ' + (el.getAttribute('class') || '')).toLowerCase();
    // chessground style: "piece white pawn" or "piece black knight"
    let color = null, type = null;
    if (cls.includes('white')) color = 'w';
    else if (cls.includes('black')) color = 'b';

    if (cls.includes('king')) type = 'k';
    else if (cls.includes('queen')) type = 'q';
    else if (cls.includes('rook')) type = 'r';
    else if (cls.includes('bishop')) type = 'b';
    else if (cls.includes('knight')) type = 'n';
    else if (cls.includes('pawn')) type = 'p';

    if (color && type) {
      return color === 'w' ? type.toUpperCase() : type;
    }

    // Alternative: data-piece attr
    const dp = el.getAttribute && el.getAttribute('data-piece');
    if (dp) {
      const c = dp[0];
      const t = dp[1] || '';
      if (c === 'w' && t) return t.toUpperCase();
      if (c === 'b' && t) return t.toLowerCase();
    }

    return null;
  }

  function getPiecePosition(el, rect, sqW, sqH) {
    // Method 1: from element's bounding rect (most reliable)
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const col = Math.floor((cx - rect.left) / sqW);
    const row = Math.floor((cy - rect.top) / sqH);
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;
    return { col, row };
  }

  // ── DIAGNOSTIC MODE ────────────────────────────────────────────────────────
  function collectDiagnostics() {
    const out = {
      diagnostic: true,
      url: location.href,
      visibleBoard: null,
      domFen: null,
      pieceSamples: [],
    };

    const boardInfo = findBoardElement();
    if (!boardInfo.error) {
      out.visibleBoard = {
        tag: boardInfo.tag,
        cls: boardInfo.cls,
        rect: { left: Math.round(boardInfo.left), top: Math.round(boardInfo.top),
                w: Math.round(boardInfo.width), h: Math.round(boardInfo.height) },
      };

      // Sample the first few piece elements to see their structure
      const pieceEls = boardInfo.el.querySelectorAll('piece, [class*="piece"], [class*="Piece"]');
      out.pieceCount = pieceEls.length;
      for (let i = 0; i < Math.min(8, pieceEls.length); i++) {
        const p = pieceEls[i];
        const r = p.getBoundingClientRect();
        out.pieceSamples.push({
          tag: p.tagName,
          cls: (p.className || '').toString().substring(0, 80),
          dataPiece: p.getAttribute('data-piece') || null,
          dataSquare: p.getAttribute('data-square') || null,
          style: (p.getAttribute('style') || '').substring(0, 80),
          rect: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
          identifiedAs: identifyPiece(p),
        });
      }

      // Try DOM-based FEN
      const fenResult = extractFenFromDom(boardInfo);
      out.domFen = fenResult;
    } else {
      out.boardError = boardInfo.error;
    }

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

    // Read clock times from the visible UI.
    // chessfriends shows "TIME" labels with mm:ss values on each player's panel.
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
      method: 'dom-extract',
      pieceCount: fenResult.pieceCount,
      clocks,
    };
  }

  function readClocks() {
    // Find all TIME-labeled clock displays. chessfriends shows them as text like "10:00".
    // We find every element whose text matches mm:ss pattern, then pick the two largest
    // (player clocks, not chat timestamps or bonus timers).
    try {
      const all = document.querySelectorAll('div, span');
      const found = [];
      const re = /^\s*(\d{1,2}):(\d{2})\s*$/;
      for (const el of all) {
        if (el.children.length > 0) continue; // leaf nodes only
        const t = (el.textContent || '').trim();
        const m = t.match(re);
        if (!m) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 14) continue;
        if (r.top < 0 || r.top > window.innerHeight) continue;
        const minutes = parseInt(m[1], 10);
        const seconds = parseInt(m[2], 10);
        if (minutes > 99) continue; // sanity
        found.push({
          text: t,
          ms: (minutes * 60 + seconds) * 1000,
          rect: r,
          fontSize: parseFloat(getComputedStyle(el).fontSize) || 0,
        });
      }
      // Sort by font size descending — player clocks are typically large
      found.sort((a, b) => b.fontSize - a.fontSize);
      const top = found.slice(0, 2);
      if (top.length < 2) return null;
      // Sort the top two by Y: top one = opponent (top of screen), bottom = us
      // BUT this depends on orientation. We'll let the caller figure that out
      // by returning both with their positions.
      top.sort((a, b) => a.rect.top - b.rect.top);
      return {
        topMs: top[0].ms,    // player at top of screen
        bottomMs: top[1].ms, // player at bottom of screen
      };
    } catch (e) {
      return null;
    }
  }
})();
