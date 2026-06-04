// content.js — chess.com edition
(function () {
  'use strict';

  const STOCKFISH_URL = 'http://localhost:8765/bestmove';
  const OVERLAY_ID = 'chess-advisor-overlay';
  const STATUS_ID = 'chess-advisor-status';
  const TOGGLE_ID = 'chess-advisor-toggle';

  // Inject the page-world script
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);

  // State
  let autoMode = true;
  let autoPlay = false;
  let premoveEnabled = false;
  let lastFen = null;
  let inflight = false;
  let pollTimer = null;
  let myColor = null;
  let lastPlayedFen = null;
  let pendingPremove = null;
  let lastPremoveAttempt = null;

  chrome.storage.local.get(['autoMode', 'autoPlay', 'premoveEnabled'], (data) => {
    if (typeof data.autoMode === 'boolean') autoMode = data.autoMode;
    if (typeof data.autoPlay === 'boolean') autoPlay = data.autoPlay;
    if (typeof data.premoveEnabled === 'boolean') premoveEnabled = data.premoveEnabled;
    renderToggle();
    if (autoMode) startPolling();
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'GET_BEST_MOVE') {
      handleBestMoveRequest(true).then(sendResponse);
      return true;
    }
    if (msg.type === 'DIAGNOSTIC') {
      runDiagnostic().then(sendResponse);
      return true;
    }
    if (msg.type === 'TOGGLE_AUTO') {
      autoMode = !!msg.enabled;
      chrome.storage.local.set({ autoMode });
      renderToggle();
      if (autoMode) { lastFen = null; startPolling(); }
      else { stopPolling(); removeOverlay(); hideStatus(); }
      sendResponse({ autoMode });
      return true;
    }
    if (msg.type === 'GET_AUTO_STATE') {
      sendResponse({ autoMode, autoPlay, premoveEnabled });
      return true;
    }
    if (msg.type === 'TOGGLE_AUTOPLAY') {
      autoPlay = !!msg.enabled;
      chrome.storage.local.set({ autoPlay });
      renderToggle();
      sendResponse({ autoPlay });
      return true;
    }
    if (msg.type === 'TOGGLE_PREMOVE') {
      premoveEnabled = !!msg.enabled;
      chrome.storage.local.set({ premoveEnabled });
      pendingPremove = null;
      renderToggle();
      sendResponse({ premoveEnabled });
      return true;
    }
  });

  function startPolling() { stopPolling(); pollTimer = setInterval(tick, 600); }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  async function tick() {
    if (!autoMode || inflight) return;
    let state;
    try { state = await readGameStateFromPage(); } catch (e) { return; }
    if (!state || state.error || !state.fen) return;

    const STARTING_POS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
    const currentColor = state.flipped ? 'b' : 'w';

    if (myColor !== null && myColor !== currentColor) {
      myColor = currentColor;
      lastFen = null;
      lastPlayedFen = null;
      removeOverlay();
    } else if (myColor === null) {
      myColor = currentColor;
    }

    const posOnly = state.fen.split(' ')[0];
    const lastPos = lastFen ? lastFen.split(' ')[0] : null;
    if (posOnly === lastPos) return;

    if (posOnly === STARTING_POS) {
      lastFen = state.fen;
      removeOverlay();
      if (myColor === 'w') {
        const fenWithTurn = posOnly + ' w - - 0 1';
        requestMove(fenWithTurn, state, true);
      }
      return;
    }

    if (!lastPos) {
      lastFen = state.fen;
      return;
    }

    const moverColor = detectMover(lastPos, posOnly);
    lastFen = state.fen;
    if (!moverColor) { removeOverlay(); return; }
    if (moverColor === myColor) {
      removeOverlay();
      // Drag queued premove during opp turn (if any)
      if (premoveEnabled && autoPlay && pendingPremove && pendingPremove.uci) {
        const pm = pendingPremove;
        pendingPremove = null;
        setTimeout(() => playMove(state, pm.uci), 50 + Math.random() * 100);
      }
      return;
    }

    // Opponent moved → our turn
    if (pendingPremove && pendingPremove.expectedOppFen) {
      const expectedPos = pendingPremove.expectedOppFen.split(' ')[0];
      if (expectedPos !== posOnly) {
        pendingPremove = null;
      }
    }
    const fenWithTurn = posOnly + ' ' + myColor + ' - - 0 1';
    requestMove(fenWithTurn, state, true);
  }

  function detectMover(prevPos, currPos) {
    const prev = expandFenRow(prevPos);
    const curr = expandFenRow(currPos);
    if (!prev || !curr) return null;
    const vacated = [], arrived = [];
    for (let i = 0; i < 64; i++) {
      if (prev[i] !== curr[i]) {
        if (prev[i] !== '.') vacated.push({ idx: i, piece: prev[i] });
        if (curr[i] !== '.') arrived.push({ idx: i, piece: curr[i] });
      }
    }
    if (arrived.length === 0) return null;
    for (const a of arrived) {
      const aColor = a.piece === a.piece.toUpperCase() ? 'w' : 'b';
      if (vacated.find(v => (v.piece === v.piece.toUpperCase() ? 'w' : 'b') === aColor)) return aColor;
    }
    const vColors = new Set(vacated.map(v => v.piece === v.piece.toUpperCase() ? 'w' : 'b'));
    if (vColors.size === 1) return [...vColors][0];
    return null;
  }

  function expandFenRow(pos) {
    try {
      const ranks = pos.split('/');
      if (ranks.length !== 8) return null;
      let out = '';
      for (const rank of ranks) {
        for (const ch of rank) {
          if (ch >= '1' && ch <= '8') out += '.'.repeat(parseInt(ch, 10));
          else out += ch;
        }
      }
      return out.length === 64 ? out : null;
    } catch (e) { return null; }
  }

  async function handleBestMoveRequest(showStatusUI) {
    if (inflight) inflight = false;
    if (showStatusUI) showStatus('Reading board...');
    const state = await readGameStateFromPage();
    if (state.error) {
      if (showStatusUI) showStatus('❌ ' + state.error, 4000);
      return { error: state.error };
    }
    if (!myColor) myColor = state.flipped ? 'b' : 'w';
    return requestMove(state.fen, state, showStatusUI);
  }

  async function requestMove(fen, state, showStatusUI) {
    inflight = true;
    try {
      if (showStatusUI) showStatus('Thinking…');
      let move;
      try { move = await fetchBestMove(fen, state); }
      catch (err) {
        if (showStatusUI) showStatus('❌ Stockfish: ' + err.message, 6000);
        return { error: 'server: ' + err.message };
      }
      if (!move || !move.bestmove) {
        if (showStatusUI) showStatus('❌ No move returned', 4000);
        return { error: 'no move' };
      }
      drawArrow(state, move.bestmove);
      if (autoPlay && lastPlayedFen !== fen) {
        lastPlayedFen = fen;
        if (showStatusUI) showStatus('🤖 Playing ' + move.bestmove.toUpperCase(), 2500);
        const delay = 300 + Math.random() * 600;
        setTimeout(() => playMove(state, move.bestmove), delay);

        // PREMOVE
        if (premoveEnabled) {
          const fenAfterOurMove = applyUciLocal(fen, move.bestmove);
          if (fenAfterOurMove && lastPremoveAttempt !== fenAfterOurMove) {
            lastPremoveAttempt = fenAfterOurMove;
            const ourMoveTo = move.bestmove.slice(2, 4);
            fetchPremove(fenAfterOurMove, ourMoveTo).then(pre => {
              if (pre && pre.skipped) {
                pendingPremove = null;
                if (showStatusUI) showStatus('⏩ No premove (' + (pre.reason || 'unsure') + ')', 2500);
                return;
              }
              if (pre && pre.premove) {
                pendingPremove = {
                  uci: pre.premove,
                  expectedOpponentMove: pre.predictedOpponentMove,
                  expectedOppFen: pre.fenAfterOpp,
                };
                if (showStatusUI) showStatus('⏩ Premove: ' + pre.premove.toUpperCase() + ' if opp ' + pre.predictedOpponentMove.toUpperCase() + ' (' + (pre.reason || '') + ')', 4000);
              }
            }).catch(() => {});
          }
        }
      } else {
        if (showStatusUI) showStatus('🎯 ' + move.bestmove.toUpperCase(), 3000);
      }
      return { move: move.bestmove, fen };
    } finally { inflight = false; }
  }

  // ── PLAY MOVE ─────────────────────────────────────────────────────────────
  // chess.com's wc-chess-board listens for pointer events on its surface.
  // Drag-and-drop simulation is the most reliable approach.
  function playMove(state, uci) {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promo = uci[4];

    const sqW = state.boardWidth / 8;
    const sqH = state.boardHeight / 8;

    const sc = (sq) => {
      const file = sq.charCodeAt(0) - 97;
      const rank = parseInt(sq[1], 10) - 1;
      const col = state.flipped ? 7 - file : file;
      const row = state.flipped ? rank : 7 - rank;
      return {
        x: state.boardLeft + (col + 0.5) * sqW,
        y: state.boardTop + (row + 0.5) * sqH,
      };
    };

    const f = sc(from);
    const t = sc(to);

    const board = document.querySelector('wc-chess-board, chess-board, div.cg-board, cg-board');
    if (!board) return;

    dragMove(board, f, t).then((ok) => {
      if (!ok) {
        clickAt(f.x, f.y);
        setTimeout(() => clickAt(t.x, t.y), 150);
      }
      if (promo) setTimeout(() => clickPromotionPiece(promo), 400);
    }).catch((e) => console.warn('Chess Advisor playMove error:', e));
  }

  async function dragMove(board, from, to) {
    const fireEvent = (type, x, y, EventClass = PointerEvent) => {
      const target = document.elementFromPoint(x, y) || board;
      if (!target) return;
      const opts = {
        bubbles: true, cancelable: true, composed: true, view: window,
        button: 0, buttons: type.includes('down') || type === 'pointermove' || type === 'mousemove' ? 1 : 0,
        clientX: x, clientY: y, screenX: x, screenY: y,
        pointerType: 'mouse', pointerId: 1, isPrimary: true,
      };
      try { target.dispatchEvent(new EventClass(type, opts)); }
      catch (e) {
        try { target.dispatchEvent(new MouseEvent(type.replace('pointer', 'mouse'), opts)); } catch (e2) {}
      }
    };

    fireEvent('pointerdown', from.x, from.y);
    fireEvent('mousedown', from.x, from.y, MouseEvent);
    await sleep(20);

    const steps = 5;
    for (let i = 1; i <= steps; i++) {
      const p = i / steps;
      const x = from.x + (to.x - from.x) * p;
      const y = from.y + (to.y - from.y) * p;
      fireEvent('pointermove', x, y);
      fireEvent('mousemove', x, y, MouseEvent);
      await sleep(15);
    }

    fireEvent('pointerup', to.x, to.y);
    fireEvent('mouseup', to.x, to.y, MouseEvent);
    await sleep(10);
    return true;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function clickAt(x, y) {
    const target = document.elementFromPoint(x, y);
    if (!target) return;
    const board = document.querySelector('wc-chess-board, chess-board, div.cg-board, cg-board') || target;
    const opts = (type) => ({
      bubbles: true, cancelable: true, composed: true, view: window,
      button: 0, buttons: type.includes('down') ? 1 : 0,
      clientX: x, clientY: y, screenX: x, screenY: y,
      pointerType: 'mouse', pointerId: 1, isPrimary: true,
    });
    try {
      board.dispatchEvent(new PointerEvent('pointerdown', opts('pointerdown')));
      board.dispatchEvent(new MouseEvent('mousedown', opts('mousedown')));
      board.dispatchEvent(new PointerEvent('pointerup', opts('pointerup')));
      board.dispatchEvent(new MouseEvent('mouseup', opts('mouseup')));
      board.dispatchEvent(new MouseEvent('click', opts('click')));
    } catch (e) {}
  }

  function clickPromotionPiece(piece) {
    // chess.com promotion popup: <div class="promotion-piece wq"> etc.
    const code = piece.toLowerCase();
    const sels = [
      `.promotion-piece.w${code}`,
      `.promotion-piece.b${code}`,
      `[class*="promotion"][class*="${code}"]`,
    ];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 10) {
          clickAt(r.left + r.width / 2, r.top + r.height / 2);
          return;
        }
      }
    }
    // Fallback: click any visible queen/rook/etc element
    const map = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' };
    const name = map[code];
    if (!name) return;
    const els = document.querySelectorAll(`[class*="${name}"]`);
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width > 20 && r.top > 0 && r.top < window.innerHeight) {
        clickAt(r.left + r.width / 2, r.top + r.height / 2);
        return;
      }
    }
  }

  async function fetchPremove(fenAfterOurMove, ourMoveTo) {
    try {
      const ctrl = new AbortController();
      const timeoutId = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch('http://localhost:8765/premove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fenAfterOurMove, movetime: 400, depth: 16, ourMoveTo }),
          signal: ctrl.signal,
        });
        if (!res.ok) return null;
        return await res.json();
      } finally { clearTimeout(timeoutId); }
    } catch (e) { return null; }
  }

  function applyUciLocal(fen, uci) {
    if (!fen || !uci) return null;
    const parts = fen.split(' ');
    if (parts.length < 6) return null;
    const [board, side, castling, ep, half, full] = parts;
    const grid = [];
    const rows = board.split('/');
    if (rows.length !== 8) return null;
    for (let r = 0; r < 8; r++) {
      const arr = [];
      for (const ch of rows[r]) {
        if (ch >= '1' && ch <= '8') {
          for (let i = 0; i < parseInt(ch, 10); i++) arr.push('.');
        } else arr.push(ch);
      }
      grid.push(arr);
    }
    const get = (f, rk) => grid[8 - rk][f];
    const setSq = (f, rk, p) => { grid[8 - rk][f] = p; };

    const fromFile = uci.charCodeAt(0) - 97;
    const fromRank = parseInt(uci[1], 10);
    const toFile = uci.charCodeAt(2) - 97;
    const toRank = parseInt(uci[3], 10);
    const promo = uci[4];
    const moving = get(fromFile, fromRank);
    if (!moving || moving === '.') return null;

    let newCastling = castling;
    let newEp = '-';
    let isPawn = moving.toLowerCase() === 'p';
    let isCapture = get(toFile, toRank) !== '.';

    if (moving.toLowerCase() === 'k' && Math.abs(toFile - fromFile) === 2) {
      const rookFromFile = toFile > fromFile ? 7 : 0;
      const rookToFile = toFile > fromFile ? toFile - 1 : toFile + 1;
      const rook = get(rookFromFile, fromRank);
      setSq(rookFromFile, fromRank, '.');
      setSq(rookToFile, fromRank, rook);
    }
    if (isPawn && toFile !== fromFile && get(toFile, toRank) === '.') {
      setSq(toFile, fromRank, '.');
      isCapture = true;
    }
    if (isPawn && Math.abs(toRank - fromRank) === 2) {
      newEp = String.fromCharCode(97 + fromFile) + (fromRank + toRank) / 2;
    }

    setSq(fromFile, fromRank, '.');
    let placed = moving;
    if (promo) placed = moving === moving.toUpperCase() ? promo.toUpperCase() : promo.toLowerCase();
    setSq(toFile, toRank, placed);

    if (moving === 'K') newCastling = newCastling.replace(/[KQ]/g, '');
    else if (moving === 'k') newCastling = newCastling.replace(/[kq]/g, '');
    if (fromFile === 0 && fromRank === 1) newCastling = newCastling.replace('Q', '');
    if (fromFile === 7 && fromRank === 1) newCastling = newCastling.replace('K', '');
    if (fromFile === 0 && fromRank === 8) newCastling = newCastling.replace('q', '');
    if (fromFile === 7 && fromRank === 8) newCastling = newCastling.replace('k', '');
    if (toFile === 0 && toRank === 1) newCastling = newCastling.replace('Q', '');
    if (toFile === 7 && toRank === 1) newCastling = newCastling.replace('K', '');
    if (toFile === 0 && toRank === 8) newCastling = newCastling.replace('q', '');
    if (toFile === 7 && toRank === 8) newCastling = newCastling.replace('k', '');
    if (newCastling === '') newCastling = '-';

    const newRows = [];
    for (let r = 0; r < 8; r++) {
      let s = '', empty = 0;
      for (let f = 0; f < 8; f++) {
        const c = grid[r][f];
        if (c === '.') empty++;
        else { if (empty > 0) { s += empty; empty = 0; } s += c; }
      }
      if (empty > 0) s += empty;
      newRows.push(s);
    }
    const newSide = side === 'w' ? 'b' : 'w';
    const newHalf = (isPawn || isCapture) ? '0' : String(parseInt(half, 10) + 1);
    const newFull = side === 'b' ? String(parseInt(full, 10) + 1) : full;
    return `${newRows.join('/')} ${newSide} ${newCastling} ${newEp} ${newHalf} ${newFull}`;
  }

  function readGameStateFromPage() {
    return new Promise((resolve) => {
      const listener = (e) => {
        window.removeEventListener('CHESS_ADVISOR_RESPONSE', listener);
        resolve(e.detail || { error: 'empty response' });
      };
      window.addEventListener('CHESS_ADVISOR_RESPONSE', listener);
      try { window.dispatchEvent(new CustomEvent('CHESS_ADVISOR_REQUEST')); }
      catch (e) {
        window.removeEventListener('CHESS_ADVISOR_RESPONSE', listener);
        resolve({ error: 'dispatch failed' });
        return;
      }
      setTimeout(() => {
        window.removeEventListener('CHESS_ADVISOR_RESPONSE', listener);
        resolve({ error: 'page script timeout' });
      }, 2000);
    });
  }

  function runDiagnostic() {
    return new Promise((resolve) => {
      const listener = (e) => {
        window.removeEventListener('CHESS_ADVISOR_RESPONSE', listener);
        resolve(e.detail);
      };
      window.addEventListener('CHESS_ADVISOR_RESPONSE', listener);
      window.dispatchEvent(new CustomEvent('CHESS_ADVISOR_REQUEST', { detail: { diagnostic: true } }));
      setTimeout(() => {
        window.removeEventListener('CHESS_ADVISOR_RESPONSE', listener);
        resolve({ error: 'page script timeout' });
      }, 3000);
    });
  }

  async function fetchBestMove(fen, state) {
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), 20000);
    try {
      const payload = { fen };
      if (state && state.clocks && typeof state.clocks.topMs === 'number' && typeof state.clocks.bottomMs === 'number') {
        const myMs = state.clocks.bottomMs;
        const oppMs = state.clocks.topMs;
        const myColorIsWhite = !state.flipped;
        payload.useClock = true;
        payload.wtime = myColorIsWhite ? myMs : oppMs;
        payload.btime = myColorIsWhite ? oppMs : myMs;
        payload.winc = 0;
        payload.binc = 0;
        payload.movestogo = 20;
      } else {
        payload.depth = 16;
        payload.movetime = 400;
      }
      const res = await fetch(STOCKFISH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('timeout (server not responding)');
      if (e.message && e.message.includes('Failed to fetch')) throw new Error('server not running on :8765');
      throw e;
    } finally { clearTimeout(timeoutId); }
  }

  function drawArrow(state, uci) {
    removeOverlay();
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const sqW = state.boardWidth / 8;
    const sqH = state.boardHeight / 8;

    const sc = (sq) => {
      const file = sq.charCodeAt(0) - 97;
      const rank = parseInt(sq[1], 10) - 1;
      const col = state.flipped ? 7 - file : file;
      const row = state.flipped ? rank : 7 - rank;
      return { x: state.boardLeft + (col + 0.5) * sqW, y: state.boardTop + (row + 0.5) * sqH };
    };

    const f = sc(from), t = sc(to);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = OVERLAY_ID;
    svg.setAttribute('style', 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647;');

    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
    marker.setAttribute('id', 'ca-ah');
    marker.setAttribute('markerWidth', '4'); marker.setAttribute('markerHeight', '4');
    marker.setAttribute('refX', '2'); marker.setAttribute('refY', '2');
    marker.setAttribute('orient', 'auto');
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    poly.setAttribute('points', '0 0, 4 2, 0 4');
    poly.setAttribute('fill', '#00ff88');
    marker.appendChild(poly); defs.appendChild(marker); svg.appendChild(defs);

    const c1 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c1.setAttribute('cx', f.x); c1.setAttribute('cy', f.y); c1.setAttribute('r', sqW * 0.42);
    c1.setAttribute('fill', 'rgba(0,255,136,0.5)'); c1.setAttribute('stroke', '#00ff88'); c1.setAttribute('stroke-width', '4');
    svg.appendChild(c1);

    const c2 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c2.setAttribute('cx', t.x); c2.setAttribute('cy', t.y); c2.setAttribute('r', sqW * 0.42);
    c2.setAttribute('fill', 'rgba(255,200,0,0.6)'); c2.setAttribute('stroke', '#ffc800'); c2.setAttribute('stroke-width', '4');
    svg.appendChild(c2);

    const dx = t.x - f.x, dy = t.y - f.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    const ux = dx / len, uy = dy / len;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', f.x + ux * sqW * 0.42);
    line.setAttribute('y1', f.y + uy * sqW * 0.42);
    line.setAttribute('x2', t.x - ux * sqW * 0.42);
    line.setAttribute('y2', t.y - uy * sqW * 0.42);
    line.setAttribute('stroke', '#00ff88'); line.setAttribute('stroke-width', '8');
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('marker-end', 'url(#ca-ah)');
    svg.appendChild(line);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', t.x); label.setAttribute('y', t.y - sqH * 0.55);
    label.setAttribute('fill', '#fff'); label.setAttribute('font-size', '22');
    label.setAttribute('font-weight', 'bold'); label.setAttribute('font-family', 'Arial');
    label.setAttribute('text-anchor', 'middle'); label.setAttribute('paint-order', 'stroke');
    label.setAttribute('stroke', '#000'); label.setAttribute('stroke-width', '5');
    label.textContent = uci.toUpperCase();
    svg.appendChild(label);

    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = '@keyframes ca-pulse{0%,100%{opacity:1}50%{opacity:0.55}}#' + OVERLAY_ID + '{animation:ca-pulse 1.2s infinite}';
    svg.appendChild(style);
    document.body.appendChild(svg);
  }

  function removeOverlay() {
    const old = document.getElementById(OVERLAY_ID);
    if (old) old.remove();
  }

  function showStatus(text, autoHide = 0) {
    let el = document.getElementById(STATUS_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = STATUS_ID;
      el.style.cssText = [
        'position:fixed', 'top:50px', 'right:10px',
        'background:#1a1a1a', 'color:#00ff88',
        'font-family:Arial,sans-serif', 'font-size:13px', 'font-weight:bold',
        'padding:8px 14px', 'border-radius:6px',
        'border:2px solid #00ff88', 'z-index:2147483646',
        'box-shadow:0 4px 16px rgba(0,255,136,0.5)',
        'pointer-events:none', 'max-width:300px',
      ].join(';');
      document.body.appendChild(el);
    }
    el.textContent = text;
    if (autoHide > 0) setTimeout(hideStatus, autoHide);
  }

  function hideStatus() {
    const el = document.getElementById(STATUS_ID);
    if (el) el.remove();
  }

  function renderToggle() {
    let host = document.getElementById(TOGGLE_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = TOGGLE_ID;
      host.style.cssText = [
        'position:fixed', 'top:10px', 'right:10px',
        'z-index:2147483647', 'display:flex', 'flex-direction:column', 'gap:6px',
        'font-family:Arial,sans-serif',
      ].join(';');
      document.body.appendChild(host);
    }
    host.innerHTML = '';

    const adviseBtn = makeBtn(autoMode ? '♟ ADVISE: ON' : '♟ ADVISE: OFF', autoMode);
    adviseBtn.addEventListener('click', () => {
      autoMode = !autoMode;
      chrome.storage.local.set({ autoMode });
      if (autoMode) { lastFen = null; startPolling(); }
      else {
        stopPolling(); removeOverlay(); hideStatus();
        autoPlay = false;
        premoveEnabled = false;
        pendingPremove = null;
        chrome.storage.local.set({ autoPlay, premoveEnabled });
      }
      renderToggle();
    });
    host.appendChild(adviseBtn);

    const playBtn = makeBtn(autoPlay ? '🤖 AUTO-PLAY: ON' : '🤖 AUTO-PLAY: OFF', autoPlay);
    if (!autoMode) {
      playBtn.style.opacity = '0.5';
      playBtn.title = 'Turn ADVISE on first';
    }
    playBtn.addEventListener('click', () => {
      if (!autoMode) return;
      autoPlay = !autoPlay;
      chrome.storage.local.set({ autoPlay });
      lastPlayedFen = null;
      renderToggle();
    });
    host.appendChild(playBtn);

    const preBtn = makeBtn(premoveEnabled ? '⏩ PREMOVE: ON' : '⏩ PREMOVE: OFF', premoveEnabled);
    if (!autoPlay) {
      preBtn.style.opacity = '0.5';
      preBtn.title = 'Turn AUTO-PLAY on first';
    }
    preBtn.addEventListener('click', () => {
      if (!autoPlay) return;
      premoveEnabled = !premoveEnabled;
      chrome.storage.local.set({ premoveEnabled });
      pendingPremove = null;
      lastPremoveAttempt = null;
      renderToggle();
    });
    host.appendChild(preBtn);
  }

  function makeBtn(text, on) {
    const b = document.createElement('div');
    b.textContent = text;
    b.style.cssText = [
      on ? 'background:#00ff88' : 'background:#1a1a1a',
      on ? 'color:#000' : 'color:#00ff88',
      'border:2px solid #00ff88', 'border-radius:6px',
      'padding:6px 12px', 'font-size:12px', 'font-weight:bold',
      'cursor:pointer', 'user-select:none',
      'box-shadow:0 4px 12px rgba(0,255,136,0.4)',
      'text-align:center', 'white-space:nowrap',
    ].join(';');
    return b;
  }
})();
