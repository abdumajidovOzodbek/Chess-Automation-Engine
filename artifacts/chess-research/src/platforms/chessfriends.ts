/**
 * ChessFriends.com platform adapter.
 *
 * Selectors and JS injection scripts derived from static analysis of
 * chessfriends.com/gulp_build/web_19/js/build.min.js.
 *
 * The site is a Sencha Touch / ExtJS SPA. All game state is held inside
 * Ext component instances; pieces carry CSS classes wp/bp/wk/bk etc.
 */

import type { Page } from "playwright";
import type { ResearchSessionConfig } from "../session-facade.ts";
import type { BoardExtractorConfig } from "../types.ts";
import { createLogger } from "../logger/index.ts";

export const CHESSFRIENDS_URL = "https://www.chessfriends.com";

// ─── Session selectors ────────────────────────────────────────────────────────

/**
 * Chessfriends login flow:
 * 1. The login panel (.cf-login) becomes visible when the app loads or the
 *    user taps a login CTA.
 * 2. Username / password fields are Sencha Touch textfields — the actual
 *    <input> elements carry class `x-input-el` inside each `.x-field` row.
 * 3. Submit via `button[action=login]`.
 */
export const CHESSFRIENDS_SESSION_DEFAULTS = {
  loginSelector: "button[action=login]",
  usernameSelector: ".cf-login .x-input-el",
  passwordSelector: ".cf-login .x-field:nth-of-type(2) .x-input-el, .cf-login input[type=password]",
  submitSelector: "button[action=login]",
} as const;

// ─── Logged-in detection ──────────────────────────────────────────────────────

/**
 * Script injected into page to test whether the user is already authenticated.
 * `CF.Store.getGameUser()` returns null before login, a user object after.
 */
export const CF_IS_LOGGED_IN_SCRIPT = `
(function() {
  try {
    return !!(window.CF && CF.Store && CF.Store.getGameUser && CF.Store.getGameUser());
  } catch(e) { return false; }
})()
` as const;

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
    // Pieces are children of .adv-pieces; position encoded as CSS translate or
    // square index. Attempt coordinate-based extraction via bounding-box ratios.
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
 * JS injected after login to attempt navigation to the game / quick-play view.
 * Tries the Sencha/ExtJS component tree before falling back to DOM clicks.
 */
const CF_NAVIGATE_TO_PLAY_SCRIPT = `
(function() {
  try {
    if (!window.Ext) return {ok: false, reason: 'ext_not_loaded'};

    // 1) Try known action attributes on Ext buttons
    var actionAttrs = ['quickgame','newgame','play','computer','findopponent','challenge'];
    for (var a = 0; a < actionAttrs.length; a++) {
      var found = Ext.ComponentQuery.query('button[action=' + actionAttrs[a] + ']');
      if (found && found.length) { found[0].fireEvent('tap', found[0]); return {ok:true, method:'ext_action_'+actionAttrs[a]}; }
    }

    // 2) Try tabbar — activate a tab whose title contains "play" or "game"
    var tabbars = Ext.ComponentQuery.query('tabbar');
    for (var t = 0; t < tabbars.length; t++) {
      var bar = tabbars[t];
      var items = bar.getItems ? bar.getItems().items : [];
      for (var i = 0; i < items.length; i++) {
        var tab = items[i];
        var title = (tab.getTitle && tab.getTitle()) || (tab.config && tab.config.title) || '';
        if (/play|game|chess/i.test(title)) {
          bar.setActiveTab ? bar.setActiveTab(tab) : tab.fireEvent('tap', tab);
          return {ok:true, method:'tab_'+title};
        }
      }
    }

    // 3) CF namespace — look for quickGame / startGame / findGame methods
    if (window.CF) {
      var keys = Object.keys(CF);
      for (var k = 0; k < keys.length; k++) {
        var obj = CF[keys[k]];
        if (!obj || typeof obj !== 'object') continue;
        var methods = ['quickGame','startGame','findGame','newGame','findOpponent'];
        for (var m = 0; m < methods.length; m++) {
          if (typeof obj[methods[m]] === 'function') {
            obj[methods[m]]();
            return {ok:true, method:'CF.'+keys[k]+'.'+methods[m]};
          }
        }
      }
    }

    // 4) Walk all Ext components for any with a "play/game" xtype
    var all = Ext.ComponentManager && Ext.ComponentManager.all;
    var allKeys = all ? (all.keys || Object.keys(all)) : [];
    for (var ak = 0; ak < allKeys.length; ak++) {
      var cmp = all[allKeys[ak]] || (all.getByKey && all.getByKey(allKeys[ak]));
      if (!cmp) continue;
      var xtype = cmp.xtype || (cmp.config && cmp.config.xtype) || '';
      if (/quickgame|newgame|findgame|opponent/i.test(xtype)) {
        cmp.fireEvent('tap', cmp);
        return {ok:true, method:'component_xtype_'+xtype};
      }
    }

    return {ok:false, reason:'no_play_action_found'};
  } catch(e) { return {ok:false, reason:e.message}; }
})()
`;

/**
 * Starts a chess match on chessfriends.com after authentication.
 *
 * Strategy:
 * 1. Wait for the Ext/CF namespace to fully initialise.
 * 2. Return early if a board is already visible (game in progress).
 * 3. Inject JS to navigate to the play view via Sencha components.
 * 4. Fall back to Playwright text-based button clicks.
 * 5. Wait up to 90 s for the .cf-chessboard element to appear.
 */
export async function startChessfriendsMatch(page: Page): Promise<boolean> {
  _log.info("Waiting for chessfriends app to initialise");

  // ── 1. Wait for Ext + CF namespaces ────────────────────────────────────────
  await page.waitForFunction(
    () => !!(window as unknown as Record<string, unknown>)["Ext"] &&
          !!(window as unknown as Record<string, unknown>)["CF"],
    { timeout: 45_000 }
  ).catch(() => _log.warn("CF/Ext namespace did not appear within 45 s — proceeding anyway"));

  // ── 2. Board already visible? ───────────────────────────────────────────────
  const alreadyVisible = await page.locator(".cf-chessboard").isVisible().catch(() => false);
  if (alreadyVisible) {
    _log.info("Chess board already visible — game already in progress");
    return true;
  }

  // ── 3. JS injection via Ext ComponentQuery ─────────────────────────────────
  try {
    const result = await page.evaluate(
      (script: string) => (new Function("return " + script))() as { ok: boolean; method?: string; reason?: string },
      CF_NAVIGATE_TO_PLAY_SCRIPT
    );
    _log.debug({ result }, "CF navigate-to-play result");
    if (result?.ok) {
      _log.info({ method: result.method }, "Navigated to play view via Ext");
    }
  } catch (err) {
    _log.debug({ err }, "JS navigation injection failed — falling back to DOM clicks");
  }

  // ── 4. DOM click fallbacks ─────────────────────────────────────────────────
  const buttonTexts = [
    "Quick Game", "Quick game", "Quick Play", "Quick play",
    "Play", "Find Game", "Find game", "New Game", "New game",
    "Play now", "Play Now", "Computer", "Find Opponent",
  ];

  for (const text of buttonTexts) {
    try {
      const btn = page.getByRole("button", { name: text, exact: false }).first();
      if (await btn.isVisible({ timeout: 1_200 }).catch(() => false)) {
        _log.info({ text }, "Clicking play button");
        await btn.click();
        break;
      }
    } catch { /* try next */ }
  }

  // Also try CSS class-based selectors
  const cssCandidates = [
    '[class*="quick-game"]', '[class*="quickgame"]',
    '[class*="play-btn"]',  '[class*="start-game"]',
    '[action="quickgame"]', '[action="play"]',
  ];
  for (const sel of cssCandidates) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 800 }).catch(() => false)) {
        _log.info({ sel }, "Clicking CSS-matched play element");
        await el.click();
        break;
      }
    } catch { /* try next */ }
  }

  // ── 5. Wait for board ──────────────────────────────────────────────────────
  _log.info("Waiting for chess board to appear (up to 90 s)…");
  try {
    await page.waitForSelector(".cf-chessboard", { timeout: 90_000 });
    _log.info("Chess board appeared — match started");
    return true;
  } catch {
    const visible = await page.locator(".cf-chessboard").isVisible().catch(() => false);
    if (visible) return true;
    _log.error("Board never appeared after 90 s — match start failed");
    return false;
  }
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
