/**
 * ChessFriends.com platform adapter.
 *
 * Live-tested against chessfriends.com — Sencha Touch SPA.
 * Key findings:
 *  - All UI elements are <div class="x-button"> — no native <button> tags
 *  - No [action] attributes in DOM; Ext component config has them but not DOM
 *  - Login form: input[name="nickname"] + input[type="password"]
 *  - Submit: input[type="submit"] (hidden) or Enter key on password field
 *  - Game start: click .cf-button-play div (id: ext-touchcontainer-1)
 *  - Wait strategy: CF.Store available + Ext.Viewport.rendered
 */

import type { Page } from "playwright";
import type { ResearchSessionConfig } from "../session-facade.ts";
import type { BoardExtractorConfig } from "../types.ts";
import { createLogger } from "../logger/index.ts";

export const CHESSFRIENDS_URL = "https://www.chessfriends.com";

// ─── Session selectors ────────────────────────────────────────────────────────

/**
 * Chessfriends login flow (Sencha Touch SPA):
 * 1. Click the "Sign In" div button (.x-button text "Sign In") on the welcome page
 * 2. Login dialog appears with input[name="nickname"] and input[type="password"]
 * 3. Fill credentials and press Enter (or click hidden input[type="submit"])
 */
export const CHESSFRIENDS_SESSION_DEFAULTS = {
  loginSelector: '.x-button:has-text("Sign In")',
  usernameSelector: 'input[name="nickname"]',
  passwordSelector: 'input[type="password"]',
  submitSelector: 'input[type="submit"]',
} as const;

// ─── Logged-in detection ──────────────────────────────────────────────────────

/**
 * Multi-strategy login check:
 * A) CF.Store.isLoggedIn() — direct method (most reliable)
 * B) CF.Store.gameUser direct property populated on login
 * C) CF.Store.getGameUser() prototype method
 */
export const CF_IS_LOGGED_IN_SCRIPT = `
(function() {
  try {
    if (!window.CF || !CF.Store) return false;
    if (typeof CF.Store.isLoggedIn === 'function' && CF.Store.isLoggedIn()) return true;
    var u = CF.Store.gameUser;
    if (u && typeof u === 'object' && u.nickname) return true;
    if (typeof CF.Store.getGameUser === 'function' && CF.Store.getGameUser()) return true;
    return false;
  } catch(e) { return false; }
})()
` as const;

// ─── SPA readiness wait ───────────────────────────────────────────────────────

/**
 * Wait for the Sencha Touch app to finish initialising.
 * Waits for CF.Store to be available AND Ext.Viewport to be rendered.
 * This must be called before any UI interaction on chessfriends.com.
 */
export async function waitForCFReady(page: Page, timeoutMs = 45_000): Promise<void> {
  const _log = createLogger("chessfriends-wait");
  _log.info("Waiting for CF app (Store + Ext.Viewport) to be ready...");
  await page.waitForFunction(
    () => !!(window as any)?.CF?.Store &&
          !!(window as any)?.Ext?.Viewport?.rendered,
    { timeout: timeoutMs }
  ).catch((e) => {
    _log.warn({ err: String(e) }, "CF/Ext readiness wait timed out — proceeding anyway");
  });
  // Brief settle time for Ext layout to paint
  await page.waitForTimeout(1_500);
}

// ─── FEN extraction ──────────────────────────────────────────────────────────

/**
 * Tiered JS script to extract the current FEN from chessfriends' internal
 * chess.js game state.
 *
 * Tier 1 — Sencha ComponentQuery by known xtypes
 * Tier 2 — Walk all Ext ComponentManager items looking for .chessGame
 * Tier 3 — DOM fallback: read piece classes from .cf-chessboard squares
 *
 * Returns a FEN string on success, null otherwise.
 */
export const CF_GET_FEN_SCRIPT = `
(function() {
  try {
    // Tier 1: Query by Sencha xtype
    if (window.Ext && Ext.ComponentQuery) {
      var xtypes = ['advchessboard', 'chessboard2', 'chessboard', 'cf-chessboard'];
      for (var x = 0; x < xtypes.length; x++) {
        var found = Ext.ComponentQuery.query(xtypes[x]);
        for (var i = 0; found && i < found.length; i++) {
          var cmp = found[i];
          if (cmp && cmp.chessGame && typeof cmp.chessGame.fen === 'function') {
            var fen = cmp.chessGame.fen();
            if (fen && fen.length > 10) return fen;
          }
        }
      }
    }

    // Tier 2: Walk ComponentManager
    if (window.Ext && Ext.ComponentManager) {
      var mgr = Ext.ComponentManager.all;
      var keys = mgr ? (mgr.keys || Object.keys(mgr)) : [];
      for (var k = 0; k < keys.length; k++) {
        var c = mgr[keys[k]] || (mgr.getByKey && mgr.getByKey(keys[k]));
        if (c && c.chessGame && typeof c.chessGame.fen === 'function') {
          var f = c.chessGame.fen();
          if (f && f.length > 10) return f;
        }
      }
    }

    // Tier 3: DOM — piece classes wp/wk/bp/bk on square children of .cf-chessboard
    var board = document.querySelector('.cf-chessboard');
    if (!board) return null;
    var PIECE_MAP = {
      wp:'P', wn:'N', wb:'B', wr:'R', wq:'Q', wk:'K',
      bp:'p', bn:'n', bb:'b', br:'r', bq:'q', bk:'k'
    };
    var pieces = board.querySelectorAll('.adv-pieces > *');
    if (!pieces.length) return null;
    var boardRect = board.getBoundingClientRect();
    var sqW = boardRect.width / 8;
    var sqH = boardRect.height / 8;
    var squares = {};
    var FILES = 'abcdefgh';
    pieces.forEach(function(el) {
      var cls = Array.from(el.classList);
      var pieceKey = cls.find(function(c) { return PIECE_MAP[c]; });
      if (!pieceKey) return;
      var rect = el.getBoundingClientRect();
      var cx = rect.left + rect.width / 2 - boardRect.left;
      var cy = rect.top + rect.height / 2 - boardRect.top;
      var fileIdx = Math.floor(cx / sqW);
      var rankIdx = 7 - Math.floor(cy / sqH);
      if (fileIdx < 0 || fileIdx > 7 || rankIdx < 0 || rankIdx > 7) return;
      var sq = FILES[fileIdx] + (rankIdx + 1);
      squares[sq] = PIECE_MAP[pieceKey];
    });
    if (!Object.keys(squares).length) return null;
    var fenRows = [];
    for (var rank = 8; rank >= 1; rank--) {
      var row = ''; var empty = 0;
      for (var fi = 0; fi < 8; fi++) {
        var s = FILES[fi] + rank;
        if (squares[s]) { if (empty) { row += empty; empty = 0; } row += squares[s]; }
        else empty++;
      }
      if (empty) row += empty;
      fenRows.push(row);
    }
    return fenRows.join('/') + ' w KQkq - 0 1';
  } catch(e) {
    return null;
  }
})()
` as const;

// ─── Move execution ───────────────────────────────────────────────────────────

/**
 * Returns a JS script that tries to execute `uci` move (e.g. "e2e4") via:
 * 1. ChessUtil.convertUCImoveToChessMove → component.makeMove()
 * 2. Walking ComponentManager for any component with both .chessGame and .makeMove
 *
 * Returns boolean (true = move sent, false = failed).
 */
export function cfMakeMoveScript(uci: string): string {
  return `
(function() {
  try {
    var uci = ${JSON.stringify(uci)};
    var chessMove = (window.ChessUtil && ChessUtil.convertUCImoveToChessMove)
      ? ChessUtil.convertUCImoveToChessMove(uci)
      : { from: uci.slice(0,2), to: uci.slice(2,4), promotion: uci[4] || undefined };
    if (!chessMove) return false;

    function tryMakeMove(cmp) {
      if (!cmp || !cmp.chessGame) return false;
      if (typeof cmp.makeMove === 'function') { cmp.makeMove(chessMove); return true; }
      if (typeof cmp.doMove === 'function') { cmp.doMove(chessMove); return true; }
      return false;
    }

    if (window.Ext && Ext.ComponentQuery) {
      var xtypes = ['advchessboard', 'chessboard2', 'chessboard'];
      for (var x = 0; x < xtypes.length; x++) {
        var found = Ext.ComponentQuery.query(xtypes[x]) || [];
        for (var i = 0; i < found.length; i++) {
          if (tryMakeMove(found[i])) return true;
        }
      }
      if (Ext.ComponentManager) {
        var mgr = Ext.ComponentManager.all;
        var keys = mgr ? (mgr.keys || Object.keys(mgr)) : [];
        for (var k = 0; k < keys.length; k++) {
          var c = mgr[keys[k]] || (mgr.getByKey && mgr.getByKey(keys[k]));
          if (tryMakeMove(c)) return true;
        }
      }
    }
    return false;
  } catch(e) { return false; }
})()
`;
}

// ─── Extractor config ─────────────────────────────────────────────────────────

export const CHESSFRIENDS_EXTRACTOR_CONFIG: BoardExtractorConfig = {
  boardSelector: ".cf-chessboard",
  squareSelector: ".adv-pieces > *",
  pieceSelector: ".adv-pieces > *",
  fenAttribute: "data-fen",
  pollIntervalMs: 400,
  customJsExtract: CF_GET_FEN_SCRIPT,
  customJsMoveExecutor: cfMakeMoveScript,
};

// ─── Match starter ────────────────────────────────────────────────────────────

const _log = createLogger("chessfriends-match");

/**
 * JS injected after login to navigate to the game view.
 *
 * Live-tested: the welcome page shows a .cf-button-play div (id: ext-touchcontainer-1)
 * with text "Play Now!". Clicking this starts a game search.
 * Ext buttons have no [action] attributes in the DOM — we use text-based matching.
 */
const CF_NAVIGATE_TO_PLAY_SCRIPT = `
(function() {
  try {
    if (!window.Ext) return {ok: false, reason: 'ext_not_loaded'};

    // 1) Click .cf-button-play directly (the "Play Now!" button on welcome page)
    var playBtn = document.querySelector('.cf-button-play');
    if (playBtn && playBtn.offsetParent !== null) {
      playBtn.click();
      return {ok: true, method: 'dom_cf-button-play'};
    }

    // 2) Ext ComponentQuery — buttons with play-related text
    if (Ext.ComponentQuery) {
      var allBtns = Ext.ComponentQuery.query('button') || [];
      for (var i = 0; i < allBtns.length; i++) {
        var b = allBtns[i];
        if (!b.rendered || b.hidden) continue;
        var text = String(b.getText ? b.getText() : (b.config && b.config.text) || '');
        var action = String((b.config && b.config.action) || b.action || '');
        if (/play\s*now|quick.?game|find.?game|play!/i.test(text + action)) {
          b.fireEvent('tap', b);
          return {ok: true, method: 'ext_btn_text:' + text};
        }
      }

      // 3) Try tabbar — find "Play" or "Game" tab
      var tabbars = Ext.ComponentQuery.query('tabbar') || [];
      for (var t = 0; t < tabbars.length; t++) {
        var bar = tabbars[t];
        var items = bar.getItems ? bar.getItems().items : [];
        for (var j = 0; j < items.length; j++) {
          var tab = items[j];
          var title = (tab.getTitle && tab.getTitle()) || (tab.config && tab.config.title) || '';
          if (/play|game|chess/i.test(title)) {
            bar.setActiveTab ? bar.setActiveTab(tab) : tab.fireEvent('tap', tab);
            return {ok: true, method: 'tab:' + title};
          }
        }
      }
    }

    // 4) CF namespace methods
    if (window.CF) {
      var cfKeys = Object.keys(CF);
      for (var k = 0; k < cfKeys.length; k++) {
        var obj = CF[cfKeys[k]];
        if (!obj || typeof obj !== 'object') continue;
        var methods = ['quickGame', 'startGame', 'findGame', 'newGame', 'findOpponent', 'playNow'];
        for (var m = 0; m < methods.length; m++) {
          if (typeof obj[methods[m]] === 'function') {
            try { obj[methods[m]](); } catch(e) { continue; }
            return {ok: true, method: 'CF.' + cfKeys[k] + '.' + methods[m]};
          }
        }
      }
    }

    return {ok: false, reason: 'no_play_action_found'};
  } catch(e) { return {ok: false, reason: e.message}; }
})()
`;

/** Quick helper: try CF_GET_FEN_SCRIPT and return result or null */
async function tryExtractFen(page: Page): Promise<string | null> {
  try {
    const result = await page.evaluate(
      (script: string) => (new Function("return " + script))() as string | null,
      CF_GET_FEN_SCRIPT
    );
    if (typeof result === "string" && result.length > 10) return result;
    return null;
  } catch {
    return null;
  }
}

/**
 * Starts a chess match on chessfriends.com after authentication.
 *
 * Strategy:
 * 1. Wait for CF.Store + Ext.Viewport to be fully rendered.
 * 2. Check for a REAL active game via ComponentQuery FEN extraction.
 *    (.cf-chessboard is also present on the home page Daily Puzzle —
 *     we must not return early for that.)
 * 3. If no real game, click the "New Game" button and wait for
 *    an opponent + real FEN to become available (up to 90 s).
 */
export async function startChessfriendsMatch(page: Page): Promise<boolean> {
  _log.info("Waiting for chessfriends app to initialise");

  // ── 1. Wait for Ext + CF namespaces + viewport ─────────────────────────────
  await waitForCFReady(page, 45_000);

  // ── 2. Check for a REAL active game (ComponentQuery FEN) ───────────────────
  //    The home page shows a Daily Puzzle board (.cf-chessboard) but has no
  //    Ext chess component with a live game — CF_GET_FEN_SCRIPT will return
  //    null there. Only return true when FEN is actually extractable.
  const fenNow = await tryExtractFen(page);
  if (fenNow) {
    _log.info({ fen: fenNow }, "Real game board detected (FEN extractable) — joining in-progress game");
    return true;
  }

  // ── 3. Navigate to lobby then start matchmaking ─────────────────────────────
  //
  // chessfriends.com game-start sequence (live-tested):
  //   Step A: click "New Game" on home screen → navigates to lobby (#7)
  //   Step B: click "Challenge" button in lobby → sends FilterTool.sendNewGameOffer
  //           (starts actual opponent search)
  //
  // NOTE: clicking "New Game" AGAIN at the lobby actually CANCELS the search
  //       (sends FilterTool.disposeNewGameOffer) — do NOT click it a second time.

  _log.info("No active game detected — starting matchmaking (New Game → Challenge)");

  // Step A: click the home-screen "New Game" button
  const newGameTexts = ["New Game", "New game", "Play Now!", "Play Now"];
  for (const text of newGameTexts) {
    const btn = page.locator(`.x-button:has-text("${text}")`).first();
    if (await btn.isVisible({ timeout: 1_200 }).catch(() => false)) {
      _log.info({ text }, "Step A: clicking game-start button to reach lobby");
      await btn.click({ force: true }).catch(() => {});
      break;
    }
  }

  // Wait for lobby to render
  await page.waitForTimeout(2_000);

  // Step B: click "Challenge" to send FilterTool.sendNewGameOffer (actual matchmaking)
  const challengeBtn = page.locator('.x-button:has-text("Challenge")').first();
  const challengeVisible = await challengeBtn.isVisible({ timeout: 3_000 }).catch(() => false);
  if (challengeVisible) {
    _log.info("Step B: clicking Challenge to send sendNewGameOffer (start opponent search)");
    await challengeBtn.click({ force: true }).catch(() => {});
  } else {
    // Fallback: if Challenge not visible, try cf-tile-play (accept an open challenge)
    const tilePlay = page.locator(".cf-tile-play").first();
    if (await tilePlay.isVisible({ timeout: 2_000 }).catch(() => false)) {
      _log.info("Fallback: clicking cf-tile-play to accept open challenge");
      await tilePlay.click({ force: true }).catch(() => {});
    } else {
      _log.warn("Neither Challenge nor cf-tile-play found — matchmaking may not start");
    }
  }

  // ── 4. Poll for a real game (FEN extractable) for up to 90 s ──────────────
  _log.info("Waiting up to 90 s for a real game board to become available…");
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2_000);
    const fen = await tryExtractFen(page);
    if (fen) {
      _log.info({ fen }, "Real game board detected — match ready");
      return true;
    }
    // Log progress every 10 s
    const remaining = Math.round((deadline - Date.now()) / 1000);
    if (remaining % 10 < 2) {
      _log.debug({ remaining }, "Still waiting for opponent…");
    }
  }

  _log.error("No real game board appeared within 90 s — match start failed");
  return false;
}

// ─── Full session config factory ──────────────────────────────────────────────

export interface ChessfriendsSessionOptions {
  username?: string;
  password?: string;
  color?: "w" | "b";
  depth?: number;
  movetime?: number;
  moveDelayMs?: number;
  moveJitterMs?: number;
  headless?: boolean;
  logDir?: string;
}

export function createChessfriendsConfig(
  opts: ChessfriendsSessionOptions = {}
): ResearchSessionConfig {
  return {
    session: {
      url: CHESSFRIENDS_URL,
      username: opts.username,
      password: opts.password,
      headless: opts.headless ?? true,
      ...CHESSFRIENDS_SESSION_DEFAULTS,
    },
    browser: {
      headless: opts.headless ?? true,
    },
    extractor: CHESSFRIENDS_EXTRACTOR_CONFIG,
    sync: {
      color: opts.color ?? "w",
      autoMove: true,
      moveDelayMs: opts.moveDelayMs ?? 350,
      moveJitterMs: opts.moveJitterMs ?? 500,
    },
    engine: {
      depth: opts.depth ?? 18,
      movetime: opts.movetime ?? 3000,
    },
    logDir: opts.logDir ?? "./logs/sessions",
  };
}
