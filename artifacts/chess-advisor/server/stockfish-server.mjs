/**
 * Local HTTP server that runs Stockfish and returns best moves.
 * Listens on http://localhost:8765
 *
 * Endpoints:
 *   GET  /health         - { ok: true, ready: bool }
 *   POST /bestmove       - body: { fen, depth?, movetime? } -> { bestmove, ms }
 */

import http from 'http';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { exec as execCallback } from 'child_process';

const exec = promisify(execCallback);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8765;

// Try to find stockfish in multiple locations
async function findStockfish() {
  const fs = await import('fs');
  
  // Try common installation paths (check local directory first!)
  const possiblePaths = [
    // Local server directory (EASIEST - just drop stockfish.exe here)
    path.join(__dirname, 'stockfish.exe'),
    path.join(__dirname, 'stockfish-windows-x86-64-avx2.exe'),
    // Old project location
    path.join(__dirname, '..', '..', '..', 'stockfish-bin', 'stockfish', 'stockfish-windows-x86-64-avx2.exe'),
    path.join(__dirname, '..', '..', '..', 'stockfish-bin', 'sf18', 'stockfish', 'stockfish-windows-x86-64-avx2.exe'),
    // System installation
    'C:\\Program Files\\Stockfish\\stockfish.exe',
    'C:\\Program Files\\Stockfish\\stockfish-windows-x86-64-avx2.exe',
    '/usr/local/bin/stockfish',
    '/usr/bin/stockfish',
  ];

  for (const p of possiblePaths) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }

  // Try system PATH
  try {
    if (process.platform === 'win32') {
      const { stdout } = await exec('where stockfish', { timeout: 3000 }).catch(() => ({ stdout: '' }));
      if (stdout.trim()) return stdout.trim().split('\n')[0];
    } else {
      const { stdout } = await exec('which stockfish', { timeout: 3000 }).catch(() => ({ stdout: '' }));
      if (stdout.trim()) return stdout.trim();
    }
  } catch {}

  throw new Error(`Stockfish not found!

Please download Stockfish and place it in one of these locations:
  1. ${path.join(__dirname, 'stockfish.exe')} ⭐ EASIEST
  2. C:\\Program Files\\Stockfish\\stockfish.exe
  3. Or add to your system PATH

Download from: https://github.com/official-stockfish/Stockfish/releases/download/sf_16/stockfish-windows-x86-64-avx2.zip`);
}

let STOCKFISH_EXE = null;

class Stockfish {
  constructor() {
    this.proc = null;
    this.ready = false;
    this._buf = '';
    this._resolve = null;
    this._busy = false;
    this._restartCount = 0;
    this._analyzeLines = null; // when set, collect info lines per multipv slot
  }

  start() {
    return new Promise((resolve, reject) => {
      this.proc = spawn(STOCKFISH_EXE, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc.on('error', reject);
      this.proc.on('exit', (code) => {
        console.log('[stockfish] exited code=' + code);
        this.ready = false;
        if (this._resolve) {
          const cb = this._resolve;
          this._resolve = null;
          this._busy = false;
          cb(null);
        }
        if (code !== 0 && this._restartCount < 5) {
          this._restartCount++;
          console.log('[stockfish] auto-restarting (' + this._restartCount + '/5)...');
          setTimeout(() => {
            this.start().then(() => {
              this.init();
              console.log('[stockfish] restarted ✅');
            }).catch(e => console.error('[stockfish] restart failed:', e.message));
          }, 500);
        }
      });
      this.proc.stdout.on('data', (d) => {
        this._buf += d.toString();
        const lines = this._buf.split('\n');
        this._buf = lines.pop() ?? '';
        for (const l of lines) {
          const t = l.trim();
          if (t === 'uciok') this._send('isready');
          if (t === 'readyok') {
            if (!this.ready) {
              this.ready = true;
              this._restartCount = 0;
              resolve();
            }
          }
          // Parse info lines for multi-PV analysis
          if (this._analyzeLines && t.startsWith('info ') && t.includes(' multipv ') && t.includes(' pv ')) {
            const idxM = t.match(/\bmultipv\s+(\d+)/);
            const cpM = t.match(/\bscore\s+cp\s+(-?\d+)/);
            const mateM = t.match(/\bscore\s+mate\s+(-?\d+)/);
            const pvM = t.match(/\bpv\s+([a-h][1-8][a-h][1-8][qrbn]?)/);
            if (idxM && pvM && (cpM || mateM)) {
              const idx = parseInt(idxM[1], 10);
              this._analyzeLines[idx] = {
                pv: pvM[1],
                score: cpM ? parseInt(cpM[1], 10) : null,
                mate: mateM ? parseInt(mateM[1], 10) : null,
              };
            }
          }
          if (t.startsWith('bestmove')) {
            const mv = t.split(' ')[1];
            const cb = this._resolve;
            const linesSnapshot = this._analyzeLines ? { ...this._analyzeLines } : null;
            this._resolve = null;
            this._analyzeLines = null;
            this._busy = false;
            if (cb) cb(mv === '(none)' ? null : mv, linesSnapshot);
          }
        }
      });
      this._send('uci');
    });
  }

  _send(cmd) {
    try {
      if (this.proc && this.proc.stdin && this.proc.stdin.writable && !this.proc.stdin.destroyed) {
        this.proc.stdin.write(cmd + '\n', (err) => {
          if (err && err.code === 'EPIPE') {
            // Stockfish process is gone — stop tracking it so the next request triggers a restart
            this.ready = false;
          }
        });
      }
    } catch (e) {
      // Any other write error → treat process as dead
      this.ready = false;
    }
  }

  init() {
    this._send('setoption name Skill Level value 20');
    this._send('setoption name Threads value 4');
    this._send('setoption name Hash value 256');
  }

  // Multi-PV analysis: returns { bestmove, lines: { 1: {pv, score, mate}, 2: {...}, ... } }
  // Used to detect "obvious" positions for premoves.
  analyze(fen, opts = {}) {
    fen = sanitizeFen(fen);
    return new Promise((resolve) => {
      if (!this.ready || !this.proc || this.proc.killed) { resolve(null); return; }
      if (this._busy) this._send('stop');
      this._busy = true;
      this._analyzeLines = {};
      const movetime = opts.movetime || 300;
      const multipv = opts.multipv || 3;
      this._resolve = (bestmove, lines) => resolve({ bestmove, lines: lines || {} });

      // Set MultiPV before search
      this._send('setoption name MultiPV value ' + multipv);
      this._send('position fen ' + fen);
      this._send('go movetime ' + movetime);

      // Safety
      setTimeout(() => {
        if (this._busy) {
          this._send('stop');
          setTimeout(() => {
            // Restore MultiPV to 1 for normal bestMove calls
            this._send('setoption name MultiPV value 1');
          }, 100);
        }
      }, movetime + 1500);
    });
  }

  // Smart move: probe the position first, then think proportional to complexity.
  // Returns the bestmove from the deeper search.
  async smartMove(fen, opts = {}) {
    fen = sanitizeFen(fen);
    if (!this.ready) return null;

    const { wtime, btime, sideToMove, bulletMode, repBoost } = opts;
    const myTime = sideToMove === 'b' ? btime : wtime;
    const RESERVE_MS = bulletMode ? 3000 : 5000;
    const usable = (typeof myTime === 'number') ? Math.max(50, myTime - RESERVE_MS) : 30000;
    const hardCap = Math.floor(usable / (bulletMode ? 8 : 5));

    // STEP 1: quick probe to gauge complexity
    const probeMs = bulletMode ? 100 : 80;
    const probe = await this.analyze(fen, { movetime: probeMs, multipv: 3 });
    if (!probe || !probe.bestmove) return null;

    const lines = probe.lines || {};
    const top = lines[1];
    const second = lines[2];

    let extraThink = bulletMode ? 150 : 400;
    let category = 'normal';

    if (!second) {
      extraThink = 0;
      category = 'forced';
    } else if (top && top.mate !== null && Math.abs(top.mate) <= 5) {
      extraThink = bulletMode ? 30 : 50;
      category = 'mate';
    } else if (top && second && top.score !== null && second.score !== null) {
      const gap = top.score - second.score;
      if (bulletMode) {
        // Bullet: tighter ladder but enough time to find tactics
        if (gap >= 200) { extraThink = 50; category = 'easy (gap=' + gap + ')'; }
        else if (gap >= 80) { extraThink = 120; category = 'clear (gap=' + gap + ')'; }
        else if (gap >= 30) { extraThink = 200; category = 'normal (gap=' + gap + ')'; }
        else { extraThink = 350; category = 'critical (gap=' + gap + ')'; }
      } else {
        if (gap >= 200) { extraThink = 50; category = 'easy (gap=' + gap + ')'; }
        else if (gap >= 80) { extraThink = 150; category = 'clear (gap=' + gap + ')'; }
        else if (gap >= 30) { extraThink = 400; category = 'normal (gap=' + gap + ')'; }
        else { extraThink = 800; category = 'critical (gap=' + gap + ')'; }
      }
    }

    if (extraThink > hardCap) extraThink = hardCap;

    // Repetition boost: if the client detected a repeated position, force more thinking
    // even at the cost of clock time — better to spend 600ms breaking a draw than to
    // 3-fold ourselves into a winning position.
    if (repBoost && repBoost > 0) {
      const newThink = Math.min(extraThink + repBoost, Math.floor(usable / 4));
      console.log(`[smart] repetition boost: ${extraThink}ms → ${newThink}ms`);
      extraThink = newThink;
      category = 'repetition-boost (' + category + ')';
    }

    if (extraThink <= 50) {
      console.log(`[smart${bulletMode ? '/B' : ''}] ${category} → use probe move ${probe.bestmove} (${probeMs + extraThink}ms total)`);
      if (extraThink > 0) {
        const refined = await this.bestMove(fen, { movetime: extraThink, sideToMove });
        if (refined) return refined;
      }
      return probe.bestmove;
    }

    // STEP 2: deeper search with the budgeted time
    console.log(`[smart] ${category} → deeper search ${extraThink}ms`);
    const refined = await this.bestMove(fen, { movetime: extraThink, sideToMove });
    return refined || probe.bestmove;
  }

  bestMove(fen, opts = {}) {
    fen = sanitizeFen(fen);
    return new Promise((resolve) => {
      if (!this.ready || !this.proc || this.proc.killed) {
        resolve(null);
        return;
      }
      if (this._busy) {
        this._send('stop');
      }
      this._busy = true;
      this._resolve = (mv) => resolve(mv); // ignore lines for plain bestMove
      // Ensure MultiPV is 1 (analyze() may have changed it)
      this._send('setoption name MultiPV value 1');

      const { wtime, btime, winc, binc, movestogo, depth, movetime, useClock, sideToMove, forcedMovetime } = opts;
      let goCmd;
      let expectedThinkMs = movetime || 3000;

      if (useClock && typeof wtime === 'number' && typeof btime === 'number') {
        const myTime = sideToMove === 'b' ? btime : wtime;
        const RESERVE_MS = 5000;
        const usable = Math.max(50, myTime - RESERVE_MS);

        let perMove;
        if (typeof forcedMovetime === 'number' && forcedMovetime > 0) {
          // User-forced thinking time — but always cap so we never flag.
          // Never spend more than usable/5 on a single move.
          perMove = Math.min(forcedMovetime, Math.floor(usable / 5));
          // Floor: 50ms minimum
          if (perMove < 50) perMove = Math.max(30, Math.min(usable - 50, 50));
        } else {
          // Auto mode: spend ~1/80 of remaining
          perMove = Math.floor(usable / 80);
          if (perMove > 600) perMove = 600;
          const lowTimeCap = Math.floor(usable / 10);
          if (perMove > lowTimeCap) perMove = lowTimeCap;
          if (perMove < 50) perMove = Math.max(30, Math.min(usable - 50, 50));
        }

        expectedThinkMs = perMove;
        goCmd = `go movetime ${perMove}`;
      } else {
        const mt = forcedMovetime || movetime || 400;
        expectedThinkMs = mt;
        goCmd = `go depth ${depth || 16} movetime ${mt}`;
      }

      const safetyMs = Math.ceil(expectedThinkMs * 1.5) + 1500;
      const safety = setTimeout(() => {
        if (this._resolve === resolve) {
          this._send('stop');
          setTimeout(() => {
            if (this._resolve === resolve) {
              this._resolve = null;
              this._busy = false;
              resolve(null);
            }
          }, 200);
        }
      }, safetyMs);

      this._send('position fen ' + fen);
      this._send(goCmd);
    });
  }

  quit() {
    this._send('quit');
    if (this.proc) this.proc.kill();
  }
}

const sf = new Stockfish();

// Last-resort safety nets so the server never crashes on a transient pipe error.
process.on('uncaughtException', (err) => {
  if (err && err.code === 'EPIPE') {
    console.warn('[server] swallowed EPIPE (stockfish process closed mid-write)');
    sf.ready = false;
    return;
  }
  console.error('[server] uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled rejection:', reason);
});

console.log('🔍 Looking for Stockfish...');
try {
  STOCKFISH_EXE = await findStockfish();
  console.log('✅ Found Stockfish at: ' + STOCKFISH_EXE);
} catch (e) {
  console.error('❌ ' + e.message);
  console.error('\n📥 Download Stockfish from: https://stockfishchess.org/download/');
  console.error('   Extract and place stockfish.exe in one of these locations:');
  console.error('   - C:\\Program Files\\Stockfish\\stockfish.exe');
  console.error('   - Add to system PATH');
  process.exit(1);
}

console.log('🚀 Starting Stockfish...');
try {
  await sf.start();
  sf.init();
  console.log('✅ Stockfish ready');
} catch (e) {
  console.error('❌ Failed to start Stockfish:', e.message);
  console.error('   Make sure the Stockfish executable has proper permissions.');
  process.exit(1);
}

// CORS headers for browser fetch
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── FEN sanitizer ────────────────────────────────────────────────────────────
// Stockfish can crash with access violation if the FEN claims castling rights
// that are inconsistent with piece positions (e.g. "KQkq" but no rook on h1).
// We re-derive valid castling rights from the actual board.
function sanitizeFen(fen) {
  if (!fen || typeof fen !== 'string') return fen;
  const parts = fen.split(' ');
  if (parts.length < 4) return fen;
  const board = parts[0];
  const rows = board.split('/');
  if (rows.length !== 8) return fen;

  const grid = [];
  for (let i = 0; i < 8; i++) {
    const row = rows[7 - i];
    const arr = [];
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') {
        for (let k = 0; k < parseInt(ch, 10); k++) arr.push('.');
      } else arr.push(ch);
    }
    if (arr.length !== 8) return fen;
    grid.push(arr);
  }

  let castling = '';
  if (grid[0][4] === 'K') {
    if (grid[0][7] === 'R') castling += 'K';
    if (grid[0][0] === 'R') castling += 'Q';
  }
  if (grid[7][4] === 'k') {
    if (grid[7][7] === 'r') castling += 'k';
    if (grid[7][0] === 'r') castling += 'q';
  }
  if (castling === '') castling = '-';

  parts[2] = castling;
  return parts.join(' ');
}

// ── Tiny FEN move applier ────────────────────────────────────────────────────
// Applies a UCI move to a FEN and returns the new FEN.
// Handles regular moves, captures, castling, en passant, promotion.
// Doesn't validate legality (engine returned the move, we trust it).
function applyUciMove(fen, uci) {
  if (!fen || !uci) return null;
  const parts = fen.split(' ');
  if (parts.length < 6) return null;
  const [board, side, castling, ep, half, full] = parts;

  // Expand board to 8x8
  const grid = []; // grid[rank 0..7 from bottom][file 0..7 a..h]
  const rows = board.split('/');
  if (rows.length !== 8) return null;
  for (let r = 0; r < 8; r++) {
    const fenRank = rows[r]; // r=0 is rank 8, r=7 is rank 1
    const arr = [];
    for (const ch of fenRank) {
      if (ch >= '1' && ch <= '8') {
        for (let i = 0; i < parseInt(ch, 10); i++) arr.push('.');
      } else {
        arr.push(ch);
      }
    }
    grid.push(arr);
  }
  // Helper: get/set by file (a=0..h=7) and rank (1..8)
  const get = (file, rank) => grid[8 - rank][file];
  const set = (file, rank, p) => { grid[8 - rank][file] = p; };

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

  // Castling: king moves 2 squares
  if (moving.toLowerCase() === 'k' && Math.abs(toFile - fromFile) === 2) {
    // Move the rook too
    const rookFromFile = toFile > fromFile ? 7 : 0;
    const rookToFile = toFile > fromFile ? toFile - 1 : toFile + 1;
    const rook = get(rookFromFile, fromRank);
    set(rookFromFile, fromRank, '.');
    set(rookToFile, fromRank, rook);
  }

  // En passant capture
  if (isPawn && toFile !== fromFile && get(toFile, toRank) === '.') {
    // Diagonal pawn move to empty square = en passant
    set(toFile, fromRank, '.'); // remove captured pawn
    isCapture = true;
  }

  // Set en passant target square (only if pawn moved 2 squares)
  if (isPawn && Math.abs(toRank - fromRank) === 2) {
    const epRank = (fromRank + toRank) / 2;
    newEp = String.fromCharCode(97 + fromFile) + epRank;
  }

  // Move piece (handle promotion)
  set(fromFile, fromRank, '.');
  let placed = moving;
  if (promo) {
    placed = moving === moving.toUpperCase() ? promo.toUpperCase() : promo.toLowerCase();
  }
  set(toFile, toRank, placed);

  // Update castling rights
  if (moving === 'K') newCastling = newCastling.replace(/[KQ]/g, '');
  else if (moving === 'k') newCastling = newCastling.replace(/[kq]/g, '');
  // Rook moves or captures
  if (fromFile === 0 && fromRank === 1) newCastling = newCastling.replace('Q', '');
  if (fromFile === 7 && fromRank === 1) newCastling = newCastling.replace('K', '');
  if (fromFile === 0 && fromRank === 8) newCastling = newCastling.replace('q', '');
  if (fromFile === 7 && fromRank === 8) newCastling = newCastling.replace('k', '');
  if (toFile === 0 && toRank === 1) newCastling = newCastling.replace('Q', '');
  if (toFile === 7 && toRank === 1) newCastling = newCastling.replace('K', '');
  if (toFile === 0 && toRank === 8) newCastling = newCastling.replace('q', '');
  if (toFile === 7 && toRank === 8) newCastling = newCastling.replace('k', '');
  if (newCastling === '') newCastling = '-';

  // Build new board FEN
  const newRows = [];
  for (let r = 0; r < 8; r++) {
    let s = '';
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const c = grid[r][f];
      if (c === '.') empty++;
      else {
        if (empty > 0) { s += empty; empty = 0; }
        s += c;
      }
    }
    if (empty > 0) s += empty;
    newRows.push(s);
  }
  const newBoard = newRows.join('/');

  const newSide = side === 'w' ? 'b' : 'w';
  const newHalf = (isPawn || isCapture) ? '0' : String(parseInt(half, 10) + 1);
  const newFull = side === 'b' ? String(parseInt(full, 10) + 1) : full;

  return `${newBoard} ${newSide} ${newCastling} ${newEp} ${newHalf} ${newFull}`;
}

const server = http.createServer(async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ready: sf.ready }));
    return;
  }

  if (req.method === 'POST' && req.url === '/premove') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const body_ = JSON.parse(body);
        const { fenAfterOurMove, depth, movetime, bulletMode } = body_;
        if (!fenAfterOurMove || typeof fenAfterOurMove !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'fenAfterOurMove required' }));
          return;
        }

        // STEP 1: Multi-PV analyze the opponent's options
        const analyzeMt = Math.min(400, movetime || 400);
        const analysis = await sf.analyze(fenAfterOurMove, { movetime: analyzeMt, multipv: 3 });
        if (!analysis || !analysis.bestmove) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'engine unavailable' }));
          return;
        }

        // Decide: is the opponent's reply OBVIOUS?
        // Obvious means one of:
        //   (a) It's the only legal move (only multipv 1 returned, no others)
        //   (b) Mate in N — they have to take it
        //   (c) Best move is >= 150 cp better than 2nd best (forced recapture, etc.)
        //   (d) Best move is a recapture on the same square we just moved to (instinct move)
        const lines = analysis.lines || {};
        const top = lines[1];
        const second = lines[2];
        const predictedOpp = analysis.bestmove;

        if (!top) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ skipped: true, reason: 'no analysis lines', predictedOpponentMove: predictedOpp }));
          return;
        }

        let isObvious = false;
        let reason = '';
        let confidence = 0;

        // Bullet mode uses a more lenient gap threshold but NEVER goes below 80cp.
        // The "soft" tier (30cp gap) was producing too many wrong premoves that
        // burned the single available premove slot on chessfriends.
        const gapThreshold = bulletMode ? 100 : 200;
        const recaptureGap = bulletMode ? 30 : 50;

        if (!second) {
          isObvious = true;
          reason = 'only-move';
          confidence = 100;
        } else if (top.mate !== null && top.mate <= 5 && top.mate > 0) {
          isObvious = true;
          reason = 'forced-mate';
          confidence = 95;
        } else if (top.score !== null && second.score !== null) {
          const gap = top.score - second.score;
          if (gap >= gapThreshold) {
            isObvious = true;
            reason = (bulletMode ? 'bullet-' : '') + 'forced-by-eval (gap=' + gap + 'cp)';
            confidence = Math.min(95, 70 + Math.floor(gap / 50));
          }
        }

        // Recapture rule: opp recaptures on our destination square. Even in bullet,
        // require a real gap (30cp+) to avoid wrong-color or wrong-piece guesses.
        const ourMoveTo = body_.ourMoveTo;
        if (!isObvious && ourMoveTo && predictedOpp.slice(2, 4) === ourMoveTo &&
            top.score !== null && second && second.score !== null &&
            (top.score - second.score) >= recaptureGap) {
          isObvious = true;
          reason = (bulletMode ? 'bullet-' : '') + 'recapture (gap=' + (top.score - second.score) + 'cp)';
          confidence = 80;
        }

        if (!isObvious) {
          console.log(`[premove] SKIP ${predictedOpp} not obvious (top=${top.score} 2nd=${second && second.score})`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            skipped: true,
            reason: 'not-obvious',
            predictedOpponentMove: predictedOpp,
            topScore: top.score,
            secondScore: second && second.score,
          }));
          return;
        }

        // STEP 2: Apply predicted opp move and find OUR best premove reply
        const fenAfterOpp = applyUciMove(fenAfterOurMove, predictedOpp);
        if (!fenAfterOpp) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'failed to apply predicted move', predictedOpp }));
          return;
        }

        const stmForPremove = (fenAfterOpp.split(' ')[1] || 'w').toLowerCase().startsWith('b') ? 'b' : 'w';
        const ourPremove = await sf.bestMove(fenAfterOpp, {
          movetime: analyzeMt,
          depth: depth || 16,
          sideToMove: stmForPremove,
        });
        if (!ourPremove) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'engine unavailable on premove calc', predictedOpp }));
          return;
        }

        console.log(`[premove] OK ${reason} | predict opp=${predictedOpp} our premove=${ourPremove}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          predictedOpponentMove: predictedOpp,
          premove: ourPremove,
          fenAfterOpp,
          confidence,
          reason,
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/bestmove') {    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const body_ = JSON.parse(body);
        const { fen, depth, movetime, wtime, btime, winc, binc, movestogo, useClock, forcedMovetime, bulletMode, repBoost } = body_;
        if (!fen || typeof fen !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'fen required' }));
          return;
        }
        // Parse side to move from FEN
        const sideToMove = (fen.split(' ')[1] || 'w').toLowerCase().startsWith('b') ? 'b' : 'w';
        const useSmart = useClock && !forcedMovetime; // AUTO mode → use smart time allocation
        console.log('[bestmove] ' + fen + (forcedMovetime ? ` forced=${forcedMovetime}ms` : useSmart ? ` SMART (clock w=${wtime} b=${btime} stm=${sideToMove})` : useClock ? ` clock w=${wtime} b=${btime}` : ` movetime=${movetime}`));
        const t0 = Date.now();
        let mv;
        if (useSmart) {
          mv = await sf.smartMove(fen, { wtime, btime, sideToMove, bulletMode, repBoost });
        } else {
          mv = await sf.bestMove(fen, { depth, movetime, wtime, btime, winc, binc, movestogo, useClock, sideToMove, forcedMovetime });
        }
        const ms = Date.now() - t0;
        if (mv === null) {
          console.log('[bestmove] -> null (engine unavailable) (' + ms + 'ms)');
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'engine unavailable', ms }));
          return;
        }
        console.log('[bestmove] -> ' + mv + ' (' + ms + 'ms)');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ bestmove: mv, ms }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`✅ Server listening on http://localhost:${PORT}`);
  console.log('   GET  /health');
  console.log('   POST /bestmove  { fen, depth?, movetime? }');
  console.log('\nKeep this window open while using the extension.');
  console.log('Press Ctrl+C to stop.\n');
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  sf.quit();
  server.close();
  process.exit(0);
});
