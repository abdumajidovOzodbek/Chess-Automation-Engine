/**
 * ChessFriends.com WebSocket capture module.
 *
 * Protocol (confirmed via live capture):
 *   Client → Server:  {"call": "methodName", "params": [...]}
 *   Server → Client:  {"id": N, "callId": C, "params": "JSON-STRING"}
 *
 * The "params" field in server frames is a double-encoded JSON string —
 * it must be JSON.parse()'d a second time to get the actual payload.
 *
 * Game-state frames arrive after many protocol/handshake frames (frame 60+),
 * so we capture ALL frames without a count limit.
 */

import { EventEmitter } from "events";
import type { Page, WebSocket } from "playwright";
import { Chess } from "chess.js";
import { createLogger } from "../logger/index.ts";

const logger = createLogger("chessfriends-ws");

// ─── Protocol types ───────────────────────────────────────────────────────────

/** Frame sent by the browser to ChessFriends server */
export interface CFClientFrame {
  call: string;
  params: unknown[];
}

/** Frame received from ChessFriends server */
export interface CFServerFrame {
  id: number;
  callId: number;
  /** Double-encoded JSON string — must be JSON.parse()'d again */
  params: string;
}

// ─── Captured frame record ────────────────────────────────────────────────────

export interface CapturedWSFrame {
  frameIndex: number;
  dir: "send" | "recv";
  raw: string;
  parsed: unknown;
  /** Only set when inner params could be parsed (server frames) */
  innerParams?: unknown;
  /** Set when this frame contained recognisable game state */
  gameEvent?: WSGameEvent;
  ts: number;
}

// ─── Game event types ─────────────────────────────────────────────────────────

export interface WSMoveEvent {
  type: "move";
  raw: unknown;
  from: string;
  to: string;
  promotion?: string;
  /** FEN computed by applying the move to the known position, if possible */
  fen?: string;
}

export interface WSPositionEvent {
  type: "position";
  raw: unknown;
  fen: string;
}

export interface WSGameStartEvent {
  type: "game_start";
  raw: unknown;
  color?: "w" | "b";
  fen?: string;
}

export interface WSGameEndEvent {
  type: "game_end";
  raw: unknown;
  result?: string;
}

export interface WSUnknownGameEvent {
  type: "unknown_game";
  raw: unknown;
}

export type WSGameEvent =
  | WSMoveEvent
  | WSPositionEvent
  | WSGameStartEvent
  | WSGameEndEvent
  | WSUnknownGameEvent;

// ─── Capture class ────────────────────────────────────────────────────────────

export class CFWebSocketCapture extends EventEmitter {
  private frameIndex = 0;
  /** Every captured frame — unlimited, games arrive late in the stream */
  private allFrames: CapturedWSFrame[] = [];
  /** Only frames that contained a parsed game event */
  private gameFrames: CapturedWSFrame[] = [];
  private active = false;
  private currentFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  private wsUrl: string | null = null;

  /**
   * Attach to all WebSocket connections opened by `page`.
   * Must be called BEFORE page.goto() so the listener is in place
   * when the WS handshake happens.
   */
  attach(page: Page): void {
    this.active = true;
    logger.info("WS capture attached — listening for WebSocket connections");

    page.on("websocket", (ws: WebSocket) => {
      this.wsUrl = ws.url();
      logger.info({ url: this.wsUrl }, "WebSocket connection opened");

      ws.on("framesent", (frame) => {
        this.handleRaw("send", frame.payload.toString());
      });

      ws.on("framereceived", (frame) => {
        this.handleRaw("recv", frame.payload.toString());
      });

      ws.on("close", () => {
        logger.info({ url: this.wsUrl, totalFrames: this.frameIndex }, "WebSocket closed");
        this.emit("ws_closed");
      });

      ws.on("socketerror", (err) => {
        logger.warn({ err }, "WebSocket socket error");
      });
    });
  }

  // ─── Internal frame handling ─────────────────────────────────────────────────

  private handleRaw(dir: "send" | "recv", raw: string): void {
    const frameIndex = ++this.frameIndex;
    const ts = Date.now();

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Binary or non-JSON frame — skip
      return;
    }

    const record: CapturedWSFrame = { frameIndex, dir, raw, parsed, ts };

    if (dir === "recv") {
      // Server frame: {"id": N, "callId": C, "params": "JSON-STRING"}
      const sf = parsed as Record<string, unknown>;
      if (typeof sf["params"] === "string") {
        try {
          record.innerParams = JSON.parse(sf["params"] as string);
        } catch {
          // params wasn't JSON — log as-is
          record.innerParams = sf["params"];
        }

        const event = this.extractGameEvent(record.innerParams, dir, sf);
        if (event) {
          record.gameEvent = event;
          this.gameFrames.push(record);
          logger.info(
            {
              frameIndex,
              callId: sf["callId"],
              id: sf["id"],
              eventType: event.type,
              fen: "fen" in event ? event.fen : undefined,
            },
            "Game event detected in WS frame"
          );
          this.emit("game_event", event);
        } else {
          // Still log every server frame at debug level for diagnostics
          logger.debug(
            { frameIndex, callId: sf["callId"], id: sf["id"] },
            "Server WS frame (no game event)"
          );
        }
      }
    } else {
      // Client frame: {"call": "...", "params": [...]}
      const cf = parsed as Record<string, unknown>;
      logger.debug(
        { frameIndex, call: cf["call"] },
        "Client WS frame sent"
      );

      // Check if client is sending a move
      const event = this.extractGameEvent(parsed, dir, null);
      if (event) {
        record.gameEvent = event;
        this.gameFrames.push(record);
        logger.info({ frameIndex, call: cf["call"], eventType: event.type }, "Game event in sent frame");
        this.emit("game_event", event);
      }
    }

    this.allFrames.push(record);
  }

  // ─── Game-event extraction ────────────────────────────────────────────────────

  private extractGameEvent(
    params: unknown,
    _dir: "send" | "recv",
    _outerFrame: Record<string, unknown> | null
  ): WSGameEvent | null {
    if (params === null || params === undefined) return null;

    // Array of params — check each element
    if (Array.isArray(params)) {
      for (const item of params) {
        const e = this.tryExtractFromObject(item);
        if (e) return e;
      }
      return null;
    }

    if (typeof params === "object") {
      return this.tryExtractFromObject(params as Record<string, unknown>);
    }

    // String that looks like a FEN
    if (typeof params === "string" && this.looksLikeFen(params)) {
      this.currentFen = params;
      return { type: "position", raw: params, fen: params };
    }

    return null;
  }

  private tryExtractFromObject(obj: unknown): WSGameEvent | null {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    const p = obj as Record<string, unknown>;

    // ── Game-start signals ────────────────────────────────────────────────────
    const gameStartKeys = ["gameStart", "game_start", "startGame", "newGame", "gameBegin"];
    for (const k of gameStartKeys) {
      if (k in p) {
        const inner = p[k];
        const fen = this.extractFenFromValue(inner);
        const color = this.extractColorFromValue(inner);
        const ev: WSGameStartEvent = { type: "game_start", raw: obj, fen, color };
        if (fen) this.currentFen = fen;
        return ev;
      }
    }

    // ── Game-end signals ──────────────────────────────────────────────────────
    const gameEndKeys = ["gameEnd", "game_end", "gameOver", "game_over", "result", "endGame"];
    for (const k of gameEndKeys) {
      if (k in p && p[k] !== null && p[k] !== undefined) {
        const result = typeof p[k] === "string" ? p[k] as string : undefined;
        return { type: "game_end", raw: obj, result };
      }
    }

    // ── FEN directly in object ────────────────────────────────────────────────
    const fenValue = p["fen"] ?? p["position"] ?? p["board_fen"] ?? p["boardFen"] ?? p["startFen"] ?? p["initialFen"];
    if (typeof fenValue === "string" && this.looksLikeFen(fenValue)) {
      this.currentFen = fenValue;
      return { type: "position", raw: obj, fen: fenValue };
    }

    // ── Move data ────────────────────────────────────────────────────────────
    const move = this.tryExtractMove(p);
    if (move) {
      const fen = this.applyMove(move.from, move.to, move.promotion);
      if (fen) {
        this.currentFen = fen;
        return { ...move, fen };
      }
      return move;
    }

    // ── Recursive search in nested values ─────────────────────────────────────
    for (const key of Object.keys(p)) {
      const val = p[key];
      if (val && typeof val === "object") {
        const nested = this.tryExtractFromObject(val);
        if (nested) return nested;
      }
      if (typeof val === "string" && this.looksLikeFen(val)) {
        this.currentFen = val;
        return { type: "position", raw: obj, fen: val };
      }
    }

    return null;
  }

  private tryExtractMove(p: Record<string, unknown>): WSMoveEvent | null {
    // Various move field name conventions
    const from =
      p["from"] ?? p["fromSquare"] ?? p["from_square"] ?? p["src"] ??
      p["source"] ?? p["f"];
    const to =
      p["to"] ?? p["toSquare"] ?? p["to_square"] ?? p["dst"] ??
      p["dest"] ?? p["destination"] ?? p["t"];

    if (
      typeof from === "string" && typeof to === "string" &&
      /^[a-h][1-8]$/.test(from) && /^[a-h][1-8]$/.test(to)
    ) {
      const promotion =
        typeof p["promotion"] === "string" ? p["promotion"] :
        typeof p["promo"] === "string" ? p["promo"] :
        undefined;
      return { type: "move", raw: p, from, to, promotion };
    }

    // Compact "e2e4" or "e2e4q" string move
    for (const key of ["move", "uci", "m", "mv"]) {
      const v = p[key];
      if (typeof v === "string" && /^[a-h][1-8][a-h][1-8][qrbnQRBN]?$/.test(v)) {
        const from2 = v.slice(0, 2);
        const to2 = v.slice(2, 4);
        const promo = v[4]?.toLowerCase() as string | undefined;
        return { type: "move", raw: p, from: from2, to: to2, promotion: promo };
      }
    }

    return null;
  }

  private extractFenFromValue(val: unknown): string | undefined {
    if (typeof val === "string" && this.looksLikeFen(val)) return val;
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const obj = val as Record<string, unknown>;
      const candidate = obj["fen"] ?? obj["position"] ?? obj["board"];
      if (typeof candidate === "string" && this.looksLikeFen(candidate)) return candidate;
    }
    return undefined;
  }

  private extractColorFromValue(val: unknown): "w" | "b" | undefined {
    if (!val || typeof val !== "object" || Array.isArray(val)) return undefined;
    const obj = val as Record<string, unknown>;
    const c = obj["color"] ?? obj["side"] ?? obj["myColor"] ?? obj["playerColor"];
    if (c === "w" || c === "white" || c === 1) return "w";
    if (c === "b" || c === "black" || c === 0) return "b";
    return undefined;
  }

  private looksLikeFen(s: string): boolean {
    const pos = s.split(" ")[0] ?? "";
    return /^[rnbqkpRNBQKP1-8]{1,8}(\/[rnbqkpRNBQKP1-8]{1,8}){7}$/.test(pos);
  }

  private applyMove(from: string, to: string, promotion?: string): string | null {
    try {
      const chess = new Chess(this.currentFen);
      const result = chess.move({
        from: from as import("chess.js").Square,
        to: to as import("chess.js").Square,
        promotion: (promotion?.toLowerCase() as "q" | "r" | "b" | "n" | undefined),
      });
      if (result) return chess.fen();
    } catch { /* invalid position or move */ }
    return null;
  }

  // ─── Public API ───────────────────────────────────────────────────────────────

  /** Update the internally-tracked FEN (e.g. when DOM extraction is more reliable) */
  setCurrentFen(fen: string): void {
    this.currentFen = fen;
  }

  getCurrentFen(): string {
    return this.currentFen;
  }

  isActive(): boolean {
    return this.active;
  }

  getFrameCount(): number {
    return this.frameIndex;
  }

  getWsUrl(): string | null {
    return this.wsUrl;
  }

  /**
   * Diagnostic snapshot — returns all captured frames.
   * Suitable for the /ws-diagnostics API endpoint.
   */
  getDiagnostics(): {
    active: boolean;
    wsUrl: string | null;
    totalFrames: number;
    gameFrames: number;
    currentFen: string;
    recentFrames: CapturedWSFrame[];
    allGameFrames: CapturedWSFrame[];
  } {
    // Return last 100 frames for the "recent" window; all game frames always
    const recentFrames = this.allFrames.slice(-100);
    return {
      active: this.active,
      wsUrl: this.wsUrl,
      totalFrames: this.frameIndex,
      gameFrames: this.gameFrames.length,
      currentFen: this.currentFen,
      recentFrames,
      allGameFrames: [...this.gameFrames],
    };
  }

  reset(): void {
    this.allFrames = [];
    this.gameFrames = [];
    this.frameIndex = 0;
    this.currentFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  }
}
