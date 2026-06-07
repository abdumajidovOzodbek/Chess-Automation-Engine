// content.js — bridges page world (inject.js) and extension
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
  let bulletMode = false;       // when true, all timings are slashed for 1-minute games
  let forcedMovetime = 0;
  let lastFen = null;
  let inflight = false;
  let manualOverride = false;
  let pollTimer = null;
  let myColor = null;
  let lastSuggestedMove = null;
  let lastPlayedFen = null;
  let pendingPremove = null;
  let lastPremoveAttempt = null;

  // ── DEBUG LOGGING ──────────────────────────────────────────────────────────
  // All Chess Advisor logs are tagged so you can filter the console with "[CA]"
  function log(...args) {
    try { console.log('[CA]', ...args); } catch (e) {}
  }

  // Move-just-clicked tracking — used so the poller doesn't react to its own
  // mid-animation state and doesn't fire a duplicate request.
  let lastPlayedMoveUci = null;       // UCI of the move we just sent via playMove
  let lastPlayedAt = 0;               // timestamp ms when we sent it
  let waitingForOurMoveToLand = false; // true between sending click and seeing FEN reflect it
  let lastClickAt = 0;                // global click throttle
  let pendingAutoPlayTimer = null;    // timer for an in-flight autoplay click (so we can cancel it)
  let pendingAutoPlay = null;
  let lastRequestedFen = null;
  // Anti-repetition: track recent positions to detect when the engine wants to repeat
  let recentPositions = []; // array of position strings (board only) we've recently played from
  let clickRetryCount = 0; // how many times in a row our click failed to register

  chrome.storage.local.get(['autoMode', 'autoPlay', 'premoveEnabled', 'forcedMovetime', 'bulletMode'], (data) => {
    if (typeof data.autoMode === 'boolean') autoMode = data.autoMode;
    if (typeof data.autoPlay === 'boolean') autoPlay = data.autoPlay;
    if (typeof data.premoveEnabled === 'boolean') premoveEnabled = data.premoveEnabled;
    if (typeof data.forcedMovetime === 'number') forcedMovetime = data.forcedMovetime;
    if (typeof data.bulletMode === 'boolean') bulletMode = data.bulletMode;
    renderToggle();
    if (autoMode) startPolling();
  });

  // Listen for hotkey + popup messages
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
      if (autoMode) {
        lastFen = null;
        startPolling();
      } else {
        stopPolling();
        removeOverlay();
        hideStatus();
      }
      sendResponse({ autoMode });
      return true;
    }
    if (msg.type === 'GET_AUTO_STATE') {
      sendResponse({ autoMode, autoPlay, premoveEnabled, forcedMovetime, bulletMode });
      return true;
    }
    if (msg.type === 'SET_FORCED_MOVETIME') {
      const v = parseInt(msg.value, 10);
      forcedMovetime = (isNaN(v) || v < 0) ? 0 : v;
      chrome.storage.local.set({ forcedMovetime });
      renderToggle();
      sendResponse({ forcedMovetime });
      return true;
    }
    if (msg.type === 'TOGGLE_BULLET') {
      bulletMode = !!msg.enabled;
      chrome.storage.local.set({ bulletMode });
      renderToggle();
      // Restart polling at the new interval
      if (autoMode) {
        stopPolling();
        startPolling();
      }
      sendResponse({ bulletMode });
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

  // ── AUTO-MODE POLLING ──────────────────────────────────────────────────────
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(tick, bulletMode ? 100 : 200);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function tick() {
    if (!autoMode) return;
    if (inflight) return;

    // Safety: if we've been "waiting for our move" too long, our click probably failed.
    // Clear the flag so the poller can recover.
    // In bullet mode the timeout is much shorter — losing a few seconds to a stale
    // wait flag is worse than rare false-positive clears.
    const safetyTimeout = bulletMode ? 800 : 3000;
    if (waitingForOurMoveToLand && lastPlayedAt && Date.now() - lastPlayedAt > safetyTimeout) {
      log('safety: clearing waiting flag (>' + safetyTimeout + 'ms without FEN match)');
      waitingForOurMoveToLand = false;
      lastPlayedMoveUci = null;
      lastRequestedFen = null;
      lastPlayedFen = null;
    }

    let state;
    try { state = await readGameStateFromPage(); } catch (e) { return; }
    if (!state || state.error || !state.fen) {
      // Inject script returned an error (corrupt FEN, mid-animation, etc.)
      // Just skip this tick — don't pollute lastFen with garbage.
      if (state && state.error && /corrupt FEN/.test(state.error)) {
        log('skip tick: corrupt FEN read');
      }
      return;
    }

    const STARTING_POS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
    const currentColor = state.flipped ? 'b' : 'w';

    // Detect color change (new game with different orientation) → full reset
    if (myColor !== null && myColor !== currentColor) {
      myColor = currentColor;
      lastFen = null;
      lastPlayedFen = null;
      lastPlayedMoveUci = null;
      waitingForOurMoveToLand = false;
      pendingPremove = null;
      lastRequestedFen = null;
      recentPositions = [];
      clickRetryCount = 0;
      if (pendingAutoPlayTimer) { clearTimeout(pendingAutoPlayTimer); pendingAutoPlayTimer = null; }
      pendingAutoPlay = null;
      removeOverlay();
    } else if (myColor === null) {
      myColor = currentColor;
    }

    const posOnly = state.fen.split(' ')[0];
    const lastPos = lastFen ? lastFen.split(' ')[0] : null;

    // No change → done
    if (posOnly === lastPos) return;

    log('FEN CHANGED', lastPos ? lastPos.substring(0, 25) : 'null', '→', posOnly.substring(0, 25),
        'waiting=' + waitingForOurMoveToLand + ' lastUci=' + lastPlayedMoveUci);

    // CASE 1: New game starts
    if (posOnly === STARTING_POS) {
      lastFen = state.fen;
      lastPlayedMoveUci = null;
      waitingForOurMoveToLand = false;
      lastRequestedFen = null;
      lastPlayedFen = null;
      recentPositions = [];
      removeOverlay();
      if (myColor === 'w') {
        const fenWithTurn = posOnly + ' w - - 0 1';
        requestMove(fenWithTurn, state, true);
      }
      return;
    }

    // CASE 2: First read mid-game
    if (!lastPos) {
      lastFen = state.fen;
      return;
    }

    // CASE 3: Detect who moved
    const moverColor = detectMover(lastPos, posOnly);

    // CASE 3a: We were waiting for OUR auto-played move to register, and it did.
    // Don't run normal "opponent moved" logic — our own click caused this update.
    if (waitingForOurMoveToLand && lastPlayedMoveUci) {
      // CRITICAL CHECK: is our piece still at the source square?
      // If yes, our click hasn't registered yet (chessfriends animation is showing
      // mid-transit pieces). Skip this tick — DO NOT update lastFen with the corrupt
      // intermediate FEN. The next tick will see the real post-move state.
      if (isPieceStillAtSource(lastPos, posOnly, lastPlayedMoveUci)) {
        // Has it been long enough that we suspect the click actually failed?
        const sinceClick = Date.now() - lastPlayedAt;
        if (sinceClick > 400 && clickRetryCount < 2) {
          clickRetryCount++;
          log('our piece still at source after ' + sinceClick + 'ms — retrying click (attempt ' + clickRetryCount + ')');
          // Reset throttle for retry
          lastClickAt = 0;
          waitingForOurMoveToLand = false;
          // Re-fire the same move
          const uci = lastPlayedMoveUci;
          lastPlayedMoveUci = null;
          setTimeout(() => {
            lastPlayedMoveUci = uci;
            lastPlayedAt = Date.now();
            waitingForOurMoveToLand = true;
            playMove(state, uci);
          }, 30);
          return;
        }
        log('our piece still at source — click not registered yet, ignoring this tick');
        return;
      }
      // Click registered → reset retry counter
      clickRetryCount = 0;

      const expectedNew = applyUciLocal(lastFen, lastPlayedMoveUci);
      const expectedPos = expectedNew ? expectedNew.split(' ')[0] : null;
      if (expectedPos === posOnly) {
        log('our move ' + lastPlayedMoveUci + ' landed cleanly');
        lastFen = state.fen;
        waitingForOurMoveToLand = false;
        removeOverlay();
        return;
      }
      // For the "AND opp replied" path: also sanity-check the diff count.
      if (expectedPos && expectedPos !== posOnly) {
        const diffCount = countSquareDiffs(lastPos, posOnly);
        if (diffCount > 4) {
          log('suspicious FEN (diff=' + diffCount + ' squares) — waiting one more tick');
          return;
        }
        // Also: how many squares differ from EXPECTED (our move applied)?
        // Legit "opp replied" = 2 squares (or 3-4 if EP/castling).
        // Corrupt mid-animation = often 3+ in weird ways.
        const diffFromExpected = countSquareDiffs(expectedPos, posOnly);
        if (diffFromExpected > 4) {
          log('suspicious vs expected (diff=' + diffFromExpected + ') — waiting');
          return;
        }
        log('our move ' + lastPlayedMoveUci + ' landed AND opp replied (caught up in 1 tick)');
        lastFen = state.fen;
        waitingForOurMoveToLand = false;
        const fenWithTurn = posOnly + ' ' + myColor + ' - - 0 1';
        requestMove(fenWithTurn, state, true);
        return;
      }
      log('waiting-flag set but FEN does not match expected; clearing and resyncing');
      waitingForOurMoveToLand = false;
      lastPlayedMoveUci = null;
      lastRequestedFen = null;
    }

    lastFen = state.fen;

    if (!moverColor) {
      log('detectMover=null (multiple moves changed?), resyncing only');
      removeOverlay();
      return;
    }

    if (moverColor === myColor) {
      log('we moved (color=' + myColor + '); pendingPremove=' + (pendingPremove ? pendingPremove.uci : 'null'));
      removeOverlay();
      waitingForOurMoveToLand = false;
      lastPlayedMoveUci = null;
      const sinceLastClick = Date.now() - lastClickAt;
      if (premoveEnabled && autoPlay && pendingPremove && pendingPremove.uci && sinceLastClick > 600) {
        const pm = pendingPremove;
        pendingPremove = null;
        log('scheduling premove drag', pm.uci, 'in 700-1000ms (sinceLastClick=' + sinceLastClick + ')');
        setTimeout(() => playMove(state, pm.uci), 700 + Math.random() * 300);
      } else if (pendingPremove) {
        log('premove SKIP: enabled=' + premoveEnabled + ' autoPlay=' + autoPlay + ' sinceLastClick=' + sinceLastClick);
      }
      return;
    }

    log('opponent moved (color=' + moverColor + '), our turn');
    if (pendingPremove && pendingPremove.expectedOppFen) {
      const expectedPos = pendingPremove.expectedOppFen.split(' ')[0];
      if (expectedPos !== posOnly) {
        log('clearing stale premove (opp played differently)');
        pendingPremove = null;
      }
    }

    const fenWithTurn = posOnly + ' ' + myColor + ' - - 0 1';
    requestMove(fenWithTurn, state, true);
  }

  // Compare two FEN position strings (board-only, no metadata).
  // Returns 'w' if white pieces moved, 'b' if black pieces moved, null if uncertain.
  function detectMover(prevPos, currPos) {
    const prev = expandFenRow(prevPos);
    const curr = expandFenRow(currPos);
    if (!prev || !curr) return null;

    // Find squares where pieces left (vacated) and arrived
    const vacated = [];
    const arrived = [];
    for (let i = 0; i < 64; i++) {
      if (prev[i] !== curr[i]) {
        if (prev[i] !== '.') vacated.push({ idx: i, piece: prev[i] });
        if (curr[i] !== '.') arrived.push({ idx: i, piece: curr[i] });
      }
    }

    // The mover is the color of the piece that arrived (regular move/capture)
    // For castling, two pieces of the same color move; still works.
    if (arrived.length === 0) return null;

    // Find the piece that moved: it should be a piece type that vacated
    // and is the same color
    for (const a of arrived) {
      const aColor = a.piece === a.piece.toUpperCase() ? 'w' : 'b';
      // Did a piece of the same color vacate?
      const matched = vacated.find(v => {
        const vColor = v.piece === v.piece.toUpperCase() ? 'w' : 'b';
        return vColor === aColor;
      });
      if (matched) return aColor;
    }

    // Couldn't match — fallback: if only one color vacated, that's the mover
    const vColors = new Set(vacated.map(v => v.piece === v.piece.toUpperCase() ? 'w' : 'b'));
    if (vColors.size === 1) return [...vColors][0];

    return null;
  }

  // Check if our piece is still at the source square of the move we played.
  // If yes, our click hasn't actually moved the piece on the platform — we're
  // looking at a mid-animation FEN or the click silently failed.
  function isPieceStillAtSource(prevPos, currPos, uci) {
    if (!uci || uci.length < 4) return false;
    const prev = expandFenRow(prevPos);
    const curr = expandFenRow(currPos);
    if (!prev || !curr) return false;

    // Compute the source square index in the 64-char board string.
    // expandFenRow returns rank 8 first (index 0=a8), so:
    // file (a..h) = 0..7, rank (1..8) = 1..8 → index = (8-rank)*8 + file
    const file = uci.charCodeAt(0) - 97;
    const rank = parseInt(uci[1], 10);
    if (file < 0 || file > 7 || rank < 1 || rank > 8) return false;
    const idx = (8 - rank) * 8 + file;
    if (idx < 0 || idx >= 64) return false;

    // The piece at the source in the previous FEN
    const expectedPiece = prev[idx];
    if (expectedPiece === '.') return false; // no piece there to begin with — odd
    // If the same piece (or even any piece of our color) is still on the source
    // in the current FEN, the move hasn't taken effect yet.
    return curr[idx] === expectedPiece;
  }

  // Count how many squares differ between two FEN positions. Used to detect
  // mid-animation FENs where 3+ squares can briefly differ (piece in transit).
  function countSquareDiffs(prevPos, currPos) {
    const prev = expandFenRow(prevPos);
    const curr = expandFenRow(currPos);
    if (!prev || !curr) return 99;
    let diff = 0;
    for (let i = 0; i < 64; i++) if (prev[i] !== curr[i]) diff++;
    return diff;
  }

  // Expand FEN board portion to a 64-char string with '.' for empty squares.
  // Index 0 = a8, index 63 = h1.
  function expandFenRow(pos) {
    try {
      const ranks = pos.split('/');
      if (ranks.length !== 8) return null;
      let out = '';
      for (const rank of ranks) {
        for (const ch of rank) {
          if (ch >= '1' && ch <= '8') {
            out += '.'.repeat(parseInt(ch, 10));
          } else {
            out += ch;
          }
        }
      }
      return out.length === 64 ? out : null;
    } catch (e) { return null; }
  }

  async function handleBestMoveRequest(showStatusUI) {
    // Manual request always wins — cancel any in-flight auto request
    if (inflight) {
      inflight = false;
      manualOverride = true;
    }
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
    if (lastRequestedFen === fen) {
      log('requestMove SKIP: already calculated', fen.substring(0, 25));
      return { skipped: true };
    }
    if (autoPlay && (pendingAutoPlayTimer || waitingForOurMoveToLand)) {
      log('requestMove SKIP: click in flight (timer=' + !!pendingAutoPlayTimer + ' waiting=' + waitingForOurMoveToLand + ')');
      return { skipped: true };
    }
    lastRequestedFen = fen;

    // Anti-repetition: count how many times this exact position appeared recently.
    // If 2+, force a deeper search — the engine needs more time to find a different plan.
    const posKey = fen.split(' ')[0];
    const repCount = recentPositions.filter(p => p === posKey).length;
    let repBoost = 0;
    if (repCount >= 1) {
      repBoost = repCount === 1 ? 250 : 600; // significantly more time on the 2nd and 3rd seeing
      log('repetition detected (count=' + repCount + ') → boost think +' + repBoost + 'ms');
    }
    // Track this position
    recentPositions.push(posKey);
    if (recentPositions.length > 10) recentPositions = recentPositions.slice(-10);

    inflight = true;
    try {
      if (showStatusUI) showStatus('Thinking…');
      let move;
      try {
        move = await fetchBestMove(fen, state, repBoost);
      } catch (err) {
        if (showStatusUI) showStatus('❌ Stockfish server: ' + err.message, 6000);
        return { error: 'server: ' + err.message };
      }
      if (!move || !move.bestmove) {
        if (showStatusUI) showStatus('❌ Engine returned no move', 4000);
        return { error: 'no move' };
      }

      drawArrow(state, move.bestmove);

      // Auto-play: click the move on the board
      if (autoPlay && lastPlayedFen !== fen) {
        lastPlayedFen = fen;
        if (pendingAutoPlayTimer) {
          log('canceling previous autoplay timer');
          clearTimeout(pendingAutoPlayTimer);
          pendingAutoPlayTimer = null;
        }
        pendingAutoPlay = { uci: move.bestmove, fenAtRequest: fen };
        log('autoplay schedule', move.bestmove, 'fen=' + fen.substring(0, 25));
        if (showStatusUI) showStatus('🤖 Playing ' + move.bestmove.toUpperCase(), 2500);
        // Bullet: tiny delay; Normal: small delay with FEN re-verify
        const delay = bulletMode ? (30 + Math.random() * 50) : (100 + Math.random() * 150);
        pendingAutoPlayTimer = setTimeout(() => {
          pendingAutoPlayTimer = null;
          if (bulletMode) {
            // BULLET: skip the FEN re-verify (saves ~50-100ms). The throttle
            // and other guards already prevent duplication.
            lastPlayedMoveUci = move.bestmove;
            lastPlayedAt = Date.now();
            waitingForOurMoveToLand = true;
            pendingAutoPlay = null;
            playMove(state, move.bestmove);
            return;
          }
          // NORMAL: verify the position hasn't changed since calculation
          readGameStateFromPage().then(curState => {
            if (!curState || !curState.fen) {
              log('autoplay ABORT: cannot read state at fire time');
              pendingAutoPlay = null;
              return;
            }
            const curPos = curState.fen.split(' ')[0];
            const reqPos = (pendingAutoPlay && pendingAutoPlay.fenAtRequest)
              ? pendingAutoPlay.fenAtRequest.split(' ')[0] : null;
            if (curPos !== reqPos) {
              log('autoplay ABORT: position changed since calculation',
                  reqPos ? reqPos.substring(0, 20) : 'null', '→', curPos.substring(0, 20));
              pendingAutoPlay = null;
              return;
            }
            lastPlayedMoveUci = move.bestmove;
            lastPlayedAt = Date.now();
            waitingForOurMoveToLand = true;
            pendingAutoPlay = null;
            playMove(curState, move.bestmove);
          }).catch(() => { pendingAutoPlay = null; });
        }, delay);

        // PREMOVE: ask engine for predicted opp reply + our best response
        if (premoveEnabled) {
          // Compute FEN after our move locally
          const fenAfterOurMove = applyUciLocal(fen, move.bestmove);
          if (fenAfterOurMove) {
            // Avoid recomputing for the same position
            if (lastPremoveAttempt !== fenAfterOurMove) {
              lastPremoveAttempt = fenAfterOurMove;
              const ourMoveTo = move.bestmove.slice(2, 4);
              fetchPremove(fenAfterOurMove, ourMoveTo, bulletMode).then(pre => {
                if (pre && pre.skipped) {
                  pendingPremove = null;
                  log('premove fetch SKIPPED (' + (pre.reason || '') + ')');
                  if (showStatusUI) showStatus('⏩ No premove (' + (pre.reason || 'unsure') + ')', 2500);
                  return;
                }
                if (pre && pre.premove) {
                  pendingPremove = {
                    uci: pre.premove,
                    expectedOpponentMove: pre.predictedOpponentMove,
                    expectedOppFen: pre.fenAfterOpp,
                    fenBefore: fenAfterOurMove,
                  };
                  log('premove queued', pre.premove, 'if opp plays', pre.predictedOpponentMove, '(' + pre.reason + ')');
                  if (showStatusUI) showStatus('⏩ Premove: ' + pre.premove.toUpperCase() + ' if opp ' + pre.predictedOpponentMove.toUpperCase() + ' (' + (pre.reason || '') + ')', 4000);
                }
              }).catch(() => {});
            }
          }
        }
      } else {
        if (showStatusUI) showStatus('🎯 ' + move.bestmove.toUpperCase(), 3000);
      }

      return { move: move.bestmove, fen };
    } finally {
      inflight = false;
    }
  }

  // Click the FROM and TO squares to execute the move on the board.
  // chessground accepts EITHER click-to-move OR drag-and-drop. We simulate drag,
  // which is more reliable because chessground binds drag handlers globally.
  function playMove(state, uci) {
    const throttleMs = bulletMode ? 350 : 700;
    const now = Date.now();
    const sinceLast = now - lastClickAt;
    if (sinceLast < throttleMs) {
      const wait = throttleMs - sinceLast;
      log('playMove THROTTLED', uci, 'wait=' + wait + 'ms (sinceLastClick=' + sinceLast + ')');
      setTimeout(() => playMove(state, uci), wait);
      return;
    }
    lastClickAt = now;
    log('playMove FIRE', uci, 'autoPlay=' + autoPlay + ' premove=' + premoveEnabled + ' bullet=' + bulletMode);

    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promo = uci[4];

    locateSquareCoords(uci, state).then((coords) => {
      const f = coords.from;
      const t = coords.to;

      // Sanity check: if coords are zero/negative, the state was stale or board
      // wasn't rendered yet. Re-read board geometry from the page right now and retry.
      if (!f || !t || f.x <= 0 || f.y <= 0 || t.x <= 0 || t.y <= 0) {
        log('coords invalid (' + JSON.stringify(coords) + ') — re-reading board state');
        readGameStateFromPage().then((freshState) => {
          if (!freshState || freshState.error || !freshState.fen) {
            log('could not re-read state — abort click');
            return;
          }
          // Try again with the fresh state — but only once
          locateSquareCoords(uci, freshState).then((coords2) => {
            const f2 = coords2.from, t2 = coords2.to;
            if (!f2 || !t2 || f2.x <= 0 || f2.y <= 0 || t2.x <= 0 || t2.y <= 0) {
              log('coords STILL invalid after re-read — abort click');
              return;
            }
            log('coords (re-read): from=(' + Math.round(f2.x) + ',' + Math.round(f2.y) + ') to=(' + Math.round(t2.x) + ',' + Math.round(t2.y) + ') method=' + coords2.method);
            sendClick(uci, freshState, f2, t2, promo);
          });
        });
        return;
      }

      log('coords from-DOM: from=(' + Math.round(f.x) + ',' + Math.round(f.y) + ') to=(' + Math.round(t.x) + ',' + Math.round(t.y) + ') method=' + coords.method);
      sendClick(uci, state, f, t, promo);
    });
  }

  function sendClick(uci, state, f, t, promo) {
    chrome.runtime.sendMessage({ type: 'TRUSTED_CLICK_MOVE', from: f, to: t }, (res) => {
      if (chrome.runtime.lastError) {
        log('TRUSTED_CLICK_MOVE send error: ' + chrome.runtime.lastError.message);
        fallbackPlay(state, uci, f, t, promo);
        return;
      }
      if (res && res.ok) {
        log('playMove via CDP click-click → ok');
        if (promo) setTimeout(() => clickPromotionPiece(promo), 300);
        return;
      }
      log('CDP click-click failed (' + (res && res.error) + '), falling back');
      fallbackPlay(state, uci, f, t, promo);
    });
  }

  // Find the on-screen coordinates for the from/to squares of a UCI move.
  // Tries to use the actual rendered piece DOM element first (reliable),
  // falls back to computed grid coordinates if the piece can't be found.
  function locateSquareCoords(uci, state) {
    return new Promise((resolve) => {
      const reqId = 'sq_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const handler = (e) => {
        if (!e.detail || e.detail.reqId !== reqId) return;
        window.removeEventListener('CHESS_ADVISOR_SQ_RESPONSE', handler);
        if (e.detail.from && e.detail.to &&
            e.detail.from.x > 0 && e.detail.from.y > 0 &&
            e.detail.to.x > 0 && e.detail.to.y > 0) {
          resolve({ from: e.detail.from, to: e.detail.to, method: e.detail.method });
          return;
        }
        // Fall back to computed grid (also validates state has real coords)
        const grid = computeGridCoords(uci, state);
        if (grid.from.x > 0 && grid.from.y > 0) resolve(grid);
        else resolve({ from: { x: -1, y: -1 }, to: { x: -1, y: -1 }, method: 'invalid' });
      };
      window.addEventListener('CHESS_ADVISOR_SQ_RESPONSE', handler);
      window.dispatchEvent(new CustomEvent('CHESS_ADVISOR_SQ_QUERY', { detail: { reqId, uci } }));
      setTimeout(() => {
        window.removeEventListener('CHESS_ADVISOR_SQ_RESPONSE', handler);
        const grid = computeGridCoords(uci, state);
        if (grid.from.x > 0 && grid.from.y > 0) resolve(grid);
        else resolve({ from: { x: -1, y: -1 }, to: { x: -1, y: -1 }, method: 'invalid' });
      }, 200);
    });
  }

  function computeGridCoords(uci, state) {
    const sqW = state.boardWidth / 8;
    const sqH = state.boardHeight / 8;
    const sc = (sq) => {
      const file = sq.charCodeAt(0) - 97;
      const rank = parseInt(sq[1], 10) - 1;
      const col = state.flipped ? 7 - file : file;
      const row = state.flipped ? rank : 7 - rank;
      return { x: state.boardLeft + (col + 0.5) * sqW, y: state.boardTop + (row + 0.5) * sqH };
    };
    return { from: sc(uci.slice(0, 2)), to: sc(uci.slice(2, 4)), method: 'grid' };
  }

  function fallbackPlay(state, uci, f, t, promo) {
    callChessgroundMove(uci).then((result) => {
      if (result && result.pieceMoved) {
        log('playMove via chessground API → ok (piece moved)');
        if (promo) setTimeout(() => clickPromotionPiece(promo), 300);
        return;
      }
      log('chessground API failed too, falling back to drag simulation');
      const board = document.querySelector('div.cg-board, cg-board, .cg-board');
      if (!board) return;
      primeCursor(f.x, f.y);
      dragMove(board, f, t).then((ok) => {
        if (!ok) {
          clickAt(f.x, f.y);
          setTimeout(() => clickAt(t.x, t.y), 150);
        }
        if (promo) setTimeout(() => clickPromotionPiece(promo), 400);
      }).catch(() => {});
    });
  }

  // Call chessground's move() method via the page world. Returns {ok, pieceMoved}.
  function callChessgroundMove(uci) {
    return new Promise((resolve) => {
      const reqId = 'cg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const handler = (e) => {
        if (!e.detail || e.detail.reqId !== reqId) return;
        window.removeEventListener('CHESS_ADVISOR_CG_MOVE_RESPONSE', handler);
        resolve(e.detail);
      };
      window.addEventListener('CHESS_ADVISOR_CG_MOVE_RESPONSE', handler);
      window.dispatchEvent(new CustomEvent('CHESS_ADVISOR_CG_MOVE', { detail: { reqId, uci } }));
      setTimeout(() => {
        window.removeEventListener('CHESS_ADVISOR_CG_MOVE_RESPONSE', handler);
        resolve(null);
      }, 600);
    });
  }

  function primeCursor(x, y) {
    const target = document.elementFromPoint(x, y);
    if (!target) return;
    const opts = { bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, screenX: x, screenY: y,
      pointerType: 'mouse', pointerId: 1, isPrimary: true };
    try {
      target.dispatchEvent(new PointerEvent('pointerover', opts));
      target.dispatchEvent(new PointerEvent('pointerenter', opts));
      target.dispatchEvent(new MouseEvent('mouseover', opts));
      target.dispatchEvent(new MouseEvent('mouseenter', opts));
      target.dispatchEvent(new PointerEvent('pointermove', opts));
      target.dispatchEvent(new MouseEvent('mousemove', opts));
    } catch (e) {}
  }

  async function dragMove(board, from, to) {
    // chessground binds its drag handler to the cg-board element on pointerdown.
    // It requires:
    //   1. pointerdown ON THE PIECE (or square containing it) with proper coords
    //   2. several pointermoves (chessground triggers drag mode after ~3px movement)
    //   3. pointerup at destination
    // The events MUST hit the chessground container even when bubbling.
    //
    // Key insight: chessground prefers events dispatched on document with proper
    // coordinates rather than on a specific element. It uses elementFromPoint
    // internally based on the event's clientX/clientY.

    const buildEvent = (type, x, y, EventClass = PointerEvent) => {
      const opts = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        button: 0,
        buttons: type === 'pointerup' || type === 'mouseup' || type === 'click' ? 0 : 1,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
        pageX: x + window.scrollX,
        pageY: y + window.scrollY,
        pointerType: 'mouse',
        pointerId: 1,
        isPrimary: true,
        pressure: type === 'pointerup' || type === 'mouseup' ? 0 : 0.5,
      };
      try { return new EventClass(type, opts); } catch (e) {
        try { return new MouseEvent(type.replace('pointer', 'mouse'), opts); } catch (e2) { return null; }
      }
    };

    const fire = (type, x, y, EventClass) => {
      const ev = buildEvent(type, x, y, EventClass);
      if (!ev) return;
      const target = document.elementFromPoint(x, y) || board;
      if (!target) return;
      target.dispatchEvent(ev);
    };

    // pointerdown at source
    fire('pointerdown', from.x, from.y, PointerEvent);
    fire('mousedown', from.x, from.y, MouseEvent);
    await sleep(30);

    // chessground requires moving > a few pixels to enter drag mode.
    // Use 8 steps for smoother visual + reliable trigger.
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const p = i / steps;
      const x = from.x + (to.x - from.x) * p;
      const y = from.y + (to.y - from.y) * p;
      fire('pointermove', x, y, PointerEvent);
      fire('mousemove', x, y, MouseEvent);
      await sleep(12);
    }

    // pointerup at destination
    fire('pointerup', to.x, to.y, PointerEvent);
    fire('mouseup', to.x, to.y, MouseEvent);
    await sleep(15);

    return true;
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function clickAt(x, y) {
    const target = document.elementFromPoint(x, y);
    if (!target) return;
    const board = document.querySelector('div.cg-board, cg-board, .cg-board') || target;

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
    } catch (e) {
      console.warn('Chess Advisor click failed:', e);
    }
  }

  function clickPromotionPiece(piece) {
    // chessfriends/chessground promotion dialog: click the appropriate piece.
    // Pieces: q (queen), r (rook), b (bishop), n (knight).
    // Find a visible element with class containing the piece name.
    const map = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' };
    const className = map[piece.toLowerCase()];
    if (!className) return;
    const els = document.querySelectorAll('[class*="' + className + '"]');
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width > 20 && r.height > 20 && r.top > 0 && r.top < window.innerHeight) {
        clickAt(r.left + r.width / 2, r.top + r.height / 2);
        return;
      }
    }
  }

  async function fetchPremove(fenAfterOurMove, ourMoveTo, isBullet) {
    try {
      const ctrl = new AbortController();
      const timeoutId = setTimeout(() => ctrl.abort(), 8000);
      const payload = {
        fenAfterOurMove,
        movetime: isBullet ? 200 : 400,
        depth: isBullet ? 12 : 16,
        ourMoveTo,
        bulletMode: !!isBullet, // server uses this to relax the "obvious" threshold
      };
      try {
        const res = await fetch('http://localhost:8765/premove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        });
        if (!res.ok) return null;
        return await res.json();
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (e) { return null; }
  }

  // Local UCI move applier — same logic as server-side, mirrors the FEN forward.
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
        resolve(e.detail);
      };
      window.addEventListener('CHESS_ADVISOR_RESPONSE', listener);
      window.dispatchEvent(new CustomEvent('CHESS_ADVISOR_REQUEST'));
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

  async function fetchBestMove(fen, state, repBoost) {
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), 20000);
    try {
      // Build payload. If we have clocks, send them so Stockfish does its own time management
      // and plays full strength relative to remaining time.
      const payload = { fen };
      if (bulletMode) payload.bulletMode = true;
      if (repBoost && repBoost > 0) payload.repBoost = repBoost;
      // User-forced thinking time always wins
      if (forcedMovetime && forcedMovetime > 0) {
        payload.forcedMovetime = forcedMovetime;
      }
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
        payload.movetime = forcedMovetime || 400;
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
    } finally {
      clearTimeout(timeoutId);
    }
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
      return {
        x: state.boardLeft + (col + 0.5) * sqW,
        y: state.boardTop + (row + 0.5) * sqH,
      };
    };

    const f = sc(from);
    const t = sc(to);

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = OVERLAY_ID;
    svg.setAttribute('style', 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647;');

    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
    marker.setAttribute('id', 'ca-ah');
    marker.setAttribute('markerWidth', '4');
    marker.setAttribute('markerHeight', '4');
    marker.setAttribute('refX', '2');
    marker.setAttribute('refY', '2');
    marker.setAttribute('orient', 'auto');
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    poly.setAttribute('points', '0 0, 4 2, 0 4');
    poly.setAttribute('fill', '#00ff88');
    marker.appendChild(poly);
    defs.appendChild(marker);
    svg.appendChild(defs);

    const c1 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c1.setAttribute('cx', f.x); c1.setAttribute('cy', f.y);
    c1.setAttribute('r', sqW * 0.42);
    c1.setAttribute('fill', 'rgba(0,255,136,0.5)');
    c1.setAttribute('stroke', '#00ff88'); c1.setAttribute('stroke-width', '4');
    svg.appendChild(c1);

    const c2 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c2.setAttribute('cx', t.x); c2.setAttribute('cy', t.y);
    c2.setAttribute('r', sqW * 0.42);
    c2.setAttribute('fill', 'rgba(255,200,0,0.6)');
    c2.setAttribute('stroke', '#ffc800'); c2.setAttribute('stroke-width', '4');
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

  // ── ON-PAGE TOGGLE BUTTONS ─────────────────────────────────────────────────
  function renderToggle() {
    let host = document.getElementById(TOGGLE_ID);
    const isFirstRender = !host;
    if (!host) {
      host = document.createElement('div');
      host.id = TOGGLE_ID;
      // Restore saved position or default to top-right
      chrome.storage.local.get(['panelPos'], (data) => {
        const pos = data.panelPos || { right: 10, top: 10 };
        if (typeof pos.left === 'number') {
          host.style.left = pos.left + 'px';
          host.style.right = 'auto';
        } else {
          host.style.right = (pos.right ?? 10) + 'px';
        }
        host.style.top = (pos.top ?? 10) + 'px';
      });
      host.style.cssText = [
        'position:fixed', 'top:10px', 'right:10px',
        'z-index:2147483647', 'display:flex', 'flex-direction:column', 'gap:6px',
        'font-family:Arial,sans-serif',
      ].join(';');
      document.body.appendChild(host);
    }
    host.innerHTML = '';

    // Drag handle (also acts as a header)
    const handle = document.createElement('div');
    handle.id = 'ca-drag-handle';
    handle.style.cssText = [
      'background:#0a0a0a', 'color:#00ff88',
      'border:2px solid #00ff88', 'border-radius:6px',
      'padding:4px 10px', 'font-size:11px', 'font-weight:bold',
      'cursor:move', 'user-select:none',
      'text-align:center',
    ].join(';');
    handle.textContent = '☰ Chess Advisor (drag)';
    attachDragHandlers(handle, host);
    host.appendChild(handle);

    const adviseBtn = makeBtn(autoMode ? '♟ ADVISE: ON' : '♟ ADVISE: OFF', autoMode);
    adviseBtn.addEventListener('click', () => {
      autoMode = !autoMode;
      chrome.storage.local.set({ autoMode });
      if (autoMode) {
        lastFen = null;
        startPolling();
      } else {
        stopPolling();
        removeOverlay();
        hideStatus();
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

    // Bullet mode toggle (orange to distinguish — high-risk fast mode)
    const bulletBtn = makeBtn(bulletMode ? '⚡ BULLET: ON' : '⚡ BULLET: OFF', bulletMode);
    if (bulletMode) {
      bulletBtn.style.background = '#ff6600';
      bulletBtn.style.borderColor = '#ff6600';
      bulletBtn.style.color = '#000';
    } else {
      bulletBtn.style.borderColor = '#ff6600';
      bulletBtn.style.color = '#ff6600';
    }
    bulletBtn.title = 'Aggressive timings for 1-minute games. Faster polling, lower premove threshold, shorter delays.';
    bulletBtn.addEventListener('click', () => {
      bulletMode = !bulletMode;
      chrome.storage.local.set({ bulletMode });
      if (autoMode) { stopPolling(); startPolling(); }
      renderToggle();
    });
    host.appendChild(bulletBtn);

    // Manual "Get Move" button — works even when AUTO-ADVISE is off
    const manualBtn = makeBtn('🎯 GET MOVE NOW', false);
    manualBtn.style.background = '#ffc800';
    manualBtn.style.color = '#000';
    manualBtn.style.borderColor = '#ffc800';
    manualBtn.addEventListener('click', () => {
      handleBestMoveRequest(true).catch(() => {});
    });
    host.appendChild(manualBtn);

    // Thinking-time slider
    const slider = document.createElement('div');
    slider.style.cssText = [
      'background:#1a1a1a', 'color:#00ff88',
      'border:2px solid #00ff88', 'border-radius:6px',
      'padding:8px 12px', 'font-size:11px', 'font-weight:bold',
      'min-width:160px',
    ].join(';');

    const presetLabel = forcedMovetime === 0 ? 'AUTO (smart)' : forcedMovetime + 'ms';
    slider.innerHTML = '<div style="margin-bottom:4px;">⏱ Think: <span id="ca-think-val">' + presetLabel + '</span></div>';

    const presets = [
      { label: 'AUTO', value: 0 },
      { label: '200ms', value: 200 },
      { label: '500ms', value: 500 },
      { label: '1s', value: 1000 },
      { label: '2s', value: 2000 },
      { label: '3s', value: 3000 },
    ];
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:3px;flex-wrap:wrap;';
    for (const p of presets) {
      const b = document.createElement('div');
      b.textContent = p.label;
      const isActive = forcedMovetime === p.value;
      b.style.cssText = [
        isActive ? 'background:#00ff88' : 'background:#333',
        isActive ? 'color:#000' : 'color:#00ff88',
        'border:1px solid #00ff88', 'border-radius:3px',
        'padding:3px 6px', 'font-size:10px', 'cursor:pointer',
        'flex:1', 'text-align:center', 'white-space:nowrap',
      ].join(';');
      b.addEventListener('click', () => {
        forcedMovetime = p.value;
        chrome.storage.local.set({ forcedMovetime });
        renderToggle();
      });
      row.appendChild(b);
    }
    slider.appendChild(row);
    host.appendChild(slider);
  }

  // ── DRAGGING ──────────────────────────────────────────────────────────────
  function attachDragHandlers(handle, host) {
    let dragging = false;
    let startX = 0, startY = 0;
    let origLeft = 0, origTop = 0;

    handle.addEventListener('pointerdown', (e) => {
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = host.getBoundingClientRect();
      origLeft = rect.left;
      origTop = rect.top;
      // Switch to left-based positioning so we can move freely
      host.style.left = origLeft + 'px';
      host.style.right = 'auto';
      host.style.top = origTop + 'px';
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      let newLeft = origLeft + dx;
      let newTop = origTop + dy;
      // Clamp to viewport
      const rect = host.getBoundingClientRect();
      newLeft = Math.max(0, Math.min(window.innerWidth - rect.width, newLeft));
      newTop = Math.max(0, Math.min(window.innerHeight - rect.height, newTop));
      host.style.left = newLeft + 'px';
      host.style.top = newTop + 'px';
    });

    const finish = (e) => {
      if (!dragging) return;
      dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch (err) {}
      const rect = host.getBoundingClientRect();
      chrome.storage.local.set({ panelPos: { left: rect.left, top: rect.top } });
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
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
