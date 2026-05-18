import type { Page } from "playwright";
import { Chess } from "chess.js";
import { createLogger } from "../logger/index.ts";
import { validateFen } from "./validator.ts";
import { parseFen, STARTING_FEN, diffFens } from "./state.ts";
import type { BoardState, BoardExtractorConfig, Color, Square, PieceType } from "../types.ts";

const logger = createLogger("board-extractor");

const PIECE_CLASS_MAP: Record<string, { type: PieceType; color: Color }> = {
  wp: { type: "p", color: "w" }, wn: { type: "n", color: "w" },
  wb: { type: "b", color: "w" }, wr: { type: "r", color: "w" },
  wq: { type: "q", color: "w" }, wk: { type: "k", color: "w" },
  bp: { type: "p", color: "b" }, bn: { type: "n", color: "b" },
  bb: { type: "b", color: "b" }, br: { type: "r", color: "b" },
  bq: { type: "q", color: "b" }, bk: { type: "k", color: "b" },
  "white pawn": { type: "p", color: "w" }, "white knight": { type: "n", color: "w" },
  "white bishop": { type: "b", color: "w" }, "white rook": { type: "r", color: "w" },
  "white queen": { type: "q", color: "w" }, "white king": { type: "k", color: "w" },
  "black pawn": { type: "p", color: "b" }, "black knight": { type: "n", color: "b" },
  "black bishop": { type: "b", color: "b" }, "black rook": { type: "r", color: "b" },
  "black queen": { type: "q", color: "b" }, "black king": { type: "k", color: "b" },
};

export class BoardExtractor {
  private config: Required<BoardExtractorConfig>;
  private lastKnownFen: string = STARTING_FEN;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private onStateChange: ((state: BoardState) => void) | null = null;

  constructor(config: BoardExtractorConfig = {}) {
    this.config = {
      boardSelector: config.boardSelector ?? 'chess-board, [id*="board"], .board, cg-board',
      squareSelector: config.squareSelector ?? '[class*="square"], [data-square], cg-helper, .cg-wrap',
      pieceSelector: config.pieceSelector ?? 'piece, [class*="piece"], img[alt*="chess"]',
      fenAttribute: config.fenAttribute ?? "data-fen",
      apiEndpoint: config.apiEndpoint ?? "",
      pollIntervalMs: config.pollIntervalMs ?? 500,
    };
  }

  async extract(page: Page): Promise<BoardState | null> {
    try {
      const fenFromAttr = await this.extractFenFromAttribute(page);
      if (fenFromAttr) {
        logger.debug({ fen: fenFromAttr, method: "attribute" }, "FEN extracted");
        return parseFen(fenFromAttr);
      }

      if (this.config.apiEndpoint) {
        const fenFromApi = await this.extractFenFromApi(page);
        if (fenFromApi) {
          logger.debug({ fen: fenFromApi, method: "api" }, "FEN extracted");
          return parseFen(fenFromApi);
        }
      }

      const fenFromDom = await this.extractFenFromDom(page);
      if (fenFromDom) {
        logger.debug({ fen: fenFromDom, method: "dom" }, "FEN extracted");
        return parseFen(fenFromDom);
      }

      logger.warn("Could not extract board state via any method");
      return null;
    } catch (err) {
      logger.error({ err }, "Board extraction error");
      return null;
    }
  }

  private async extractFenFromAttribute(page: Page): Promise<string | null> {
    const candidates = [
      `chess-board[${this.config.fenAttribute}]`,
      `[${this.config.fenAttribute}]`,
      "[data-fen]",
      "[fen]",
    ];

    for (const sel of candidates) {
      try {
        const fen = await page.locator(sel).first().getAttribute(
          this.config.fenAttribute
        );
        if (fen && validateFen(fen).valid) return fen;
      } catch { /* try next */ }
    }
    return null;
  }

  private async extractFenFromApi(page: Page): Promise<string | null> {
    try {
      const response = await page.evaluate(async (endpoint: string) => {
        const res = await fetch(endpoint, { credentials: "include" });
        if (!res.ok) return null;
        return res.json() as Promise<unknown>;
      }, this.config.apiEndpoint);

      if (!response || typeof response !== "object") return null;
      const data = response as Record<string, unknown>;
      const fen = data["fen"] ?? data["position"] ?? data["board_state"];
      if (typeof fen === "string" && validateFen(fen).valid) return fen;
      return null;
    } catch {
      return null;
    }
  }

  private async extractFenFromDom(page: Page): Promise<string | null> {
    return page.evaluate(
      ([_boardSel, pieceSel]: [string, string]): string | null => {
        const PIECE_MAP: { [key: string]: string } = {
          "wp": "P", "wn": "N", "wb": "B", "wr": "R", "wq": "Q", "wk": "K",
          "bp": "p", "bn": "n", "bb": "b", "br": "r", "bq": "q", "bk": "k",
        };

        const pieceElements: HTMLElement[] = Array.from(
          document.querySelectorAll<HTMLElement>(pieceSel)
        );
        if (!pieceElements.length) return null;

        const board: { [square: string]: string } = {};

        for (const el of pieceElements) {
          const classes: string[] = Array.from(el.classList as DOMTokenList);
          const squareClass: string | undefined = classes.find(
            (c: string) => /^square-\d{2}$/.test(c)
          );
          const pieceClass: string | undefined = classes.find(
            (c: string) => Object.prototype.hasOwnProperty.call(PIECE_MAP, c)
          );

          if (squareClass && pieceClass) {
            const file = parseInt(squareClass.charAt(7), 10);
            const rank = parseInt(squareClass.charAt(8), 10);
            if (file >= 1 && file <= 8 && rank >= 1 && rank <= 8) {
              const FILES = "abcdefgh";
              const square = FILES.charAt(file - 1) + rank;
              board[square] = PIECE_MAP[pieceClass] ?? "?";
            }
          }
        }

        if (!Object.keys(board).length) return null;

        const FILES = "abcdefgh";
        let fenPosition = "";
        for (let rank = 8; rank >= 1; rank--) {
          let empty = 0;
          for (let f = 0; f < 8; f++) {
            const sq = FILES.charAt(f) + rank;
            const piece = board[sq];
            if (piece) {
              if (empty > 0) { fenPosition += empty; empty = 0; }
              fenPosition += piece;
            } else {
              empty++;
            }
          }
          if (empty > 0) fenPosition += empty;
          if (rank > 1) fenPosition += "/";
        }

        return fenPosition + " w KQkq - 0 1";
      },
      [this.config.boardSelector, this.config.pieceSelector] as [string, string]
    );
  }

  startPolling(page: Page, onStateChange: (state: BoardState) => void): void {
    if (this.pollTimer) this.stopPolling();
    this.onStateChange = onStateChange;

    this.pollTimer = setInterval(async () => {
      const state = await this.extract(page);
      if (!state) return;

      const { moved, uci } = diffFens(this.lastKnownFen, state.fen);
      if (moved) {
        logger.debug({ uci, fen: state.fen }, "Board state changed");
        this.lastKnownFen = state.fen;
        this.onStateChange?.(state);
      }
    }, this.config.pollIntervalMs);

    logger.info({ intervalMs: this.config.pollIntervalMs }, "Board polling started");
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      logger.info("Board polling stopped");
    }
  }

  setLastKnownFen(fen: string): void {
    this.lastKnownFen = fen;
  }

  getLastKnownFen(): string {
    return this.lastKnownFen;
  }

  async executeMoveOnBoard(page: Page, uci: string): Promise<boolean> {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);

    try {
      const fromSel = `[data-square="${from}"], .square-${from.charCodeAt(0) - 96}${from[1]}`;
      const toSel = `[data-square="${to}"], .square-${to.charCodeAt(0) - 96}${to[1]}`;

      const fromEl = page.locator(fromSel).first();
      const toEl = page.locator(toSel).first();

      if (!(await fromEl.isVisible().catch(() => false))) {
        logger.warn({ uci, from }, "Source square not found via data-square, trying coordinate click");
        return await this.executeMoveViaCoordinates(page, uci);
      }

      await fromEl.click();
      await page.waitForTimeout(50 + Math.random() * 80);
      await toEl.click();

      if (uci.length === 5) {
        await this.handlePromotion(page, uci[4] as PieceType);
      }

      logger.debug({ uci }, "Move executed via click");
      return true;
    } catch (err) {
      logger.error({ err, uci }, "Move execution failed");
      return false;
    }
  }

  private async executeMoveViaCoordinates(page: Page, uci: string): Promise<boolean> {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);

    const boardEl = page.locator(this.config.boardSelector).first();
    if (!(await boardEl.isVisible().catch(() => false))) return false;

    const box = await boardEl.boundingBox();
    if (!box) return false;

    const squareW = box.width / 8;
    const squareH = box.height / 8;

    const toCoords = (sq: string): { x: number; y: number } => {
      const fileIdx = sq.charCodeAt(0) - "a".charCodeAt(0);
      const rankIdx = parseInt(sq[1], 10) - 1;
      return {
        x: box.x + squareW * fileIdx + squareW / 2,
        y: box.y + box.height - squareH * rankIdx - squareH / 2,
      };
    };

    const fromCoords = toCoords(from);
    const toCoords2 = toCoords(to);

    await page.mouse.click(fromCoords.x, fromCoords.y);
    await page.waitForTimeout(50 + Math.random() * 80);
    await page.mouse.click(toCoords2.x, toCoords2.y);

    return true;
  }

  private async handlePromotion(page: Page, piece: PieceType): Promise<void> {
    const promotionSelectors: Record<PieceType, string> = {
      q: "[class*='promotion'] [class*='queen'], [class*='promo-q']",
      r: "[class*='promotion'] [class*='rook'], [class*='promo-r']",
      b: "[class*='promotion'] [class*='bishop'], [class*='promo-b']",
      n: "[class*='promotion'] [class*='knight'], [class*='promo-n']",
      p: "[class*='promotion'] [class*='pawn']",
      k: "[class*='promotion'] [class*='king']",
    };

    await page.waitForTimeout(300);
    const sel = promotionSelectors[piece];
    if (sel) {
      await page.locator(sel).first().click({ timeout: 3000 }).catch(() => {
        logger.warn({ piece }, "Promotion dialog not found — may auto-promote");
      });
    }
  }
}
