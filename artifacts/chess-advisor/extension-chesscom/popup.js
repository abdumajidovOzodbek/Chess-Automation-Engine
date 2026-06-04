async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isChessCom(url) {
  return url && (url.includes('://www.chess.com') || url.includes('://chess.com'));
}

async function refreshAutoButton() {
  const adviseBtn = document.getElementById('autoToggle');
  const playBtn = document.getElementById('autoplayToggle');
  const preBtn = document.getElementById('premoveToggle');
  const warn = document.getElementById('autoplayWarning');
  const tab = await getActiveTab();
  if (!tab || !isChessCom(tab.url)) {
    adviseBtn.textContent = 'Open chess.com first';
    adviseBtn.className = 'off';
    adviseBtn.disabled = true;
    playBtn.textContent = '—';
    playBtn.className = 'off';
    playBtn.disabled = true;
    if (preBtn) { preBtn.textContent = '—'; preBtn.className = 'off'; preBtn.disabled = true; }
    return;
  }
  adviseBtn.disabled = false;
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'GET_AUTO_STATE' });
    setAdviseBtn(res && res.autoMode);
    setPlayBtn(res && res.autoPlay, res && res.autoMode);
    setPreBtn(res && res.premoveEnabled, res && res.autoPlay);
    warn.style.display = (res && res.autoPlay) ? 'block' : 'none';
  } catch (e) {
    setAdviseBtn(false);
    setPlayBtn(false, false);
    setPreBtn(false, false);
  }
}

function setPreBtn(on, autoplayOn) {
  const btn = document.getElementById('premoveToggle');
  if (!btn) return;
  btn.disabled = !autoplayOn;
  if (!autoplayOn) {
    btn.textContent = '⏩ Premove (needs Auto-Play ON)';
    btn.className = 'off';
    return;
  }
  if (on) {
    btn.textContent = '⏩ PREMOVE: ON (queues replies)';
    btn.className = '';
  } else {
    btn.textContent = '⏩ Turn Premove ON';
    btn.className = 'off';
  }
}

function setAdviseBtn(on) {
  const btn = document.getElementById('autoToggle');
  if (on) { btn.textContent = '✅ Auto-Advise: ON'; btn.className = ''; }
  else { btn.textContent = '▶️ Turn Auto-Advise ON'; btn.className = 'off'; }
}

function setPlayBtn(on, adviseOn) {
  const btn = document.getElementById('autoplayToggle');
  btn.disabled = !adviseOn;
  if (!adviseOn) { btn.textContent = '🤖 Auto-Play (needs Advise ON)'; btn.className = 'off'; return; }
  if (on) { btn.textContent = '🤖 AUTO-PLAY: ON (clicks moves)'; btn.className = 'danger'; }
  else { btn.textContent = '🤖 Turn Auto-Play ON'; btn.className = 'off'; }
}

document.getElementById('autoToggle').addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab) return;
  try {
    const cur = await chrome.tabs.sendMessage(tab.id, { type: 'GET_AUTO_STATE' });
    const newState = !(cur && cur.autoMode);
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_AUTO', enabled: newState });
    await refreshAutoButton();
  } catch (e) {
    document.getElementById('status').textContent = 'Error: ' + e.message;
  }
});

document.getElementById('autoplayToggle').addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab) return;
  try {
    const cur = await chrome.tabs.sendMessage(tab.id, { type: 'GET_AUTO_STATE' });
    if (!cur || !cur.autoMode) return;
    const newState = !cur.autoPlay;
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_AUTOPLAY', enabled: newState });
    await refreshAutoButton();
  } catch (e) {
    document.getElementById('status').textContent = 'Error: ' + e.message;
  }
});

document.getElementById('premoveToggle').addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab) return;
  try {
    const cur = await chrome.tabs.sendMessage(tab.id, { type: 'GET_AUTO_STATE' });
    if (!cur || !cur.autoPlay) return;
    const newState = !cur.premoveEnabled;
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PREMOVE', enabled: newState });
    await refreshAutoButton();
  } catch (e) {
    document.getElementById('status').textContent = 'Error: ' + e.message;
  }
});

document.getElementById('getMove').addEventListener('click', async () => {
  const status = document.getElementById('status');
  status.textContent = 'Sending request...';
  status.className = '';
  const tab = await getActiveTab();
  if (!tab || !isChessCom(tab.url)) {
    status.textContent = 'Open chess.com first';
    status.className = 'err';
    return;
  }
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'GET_BEST_MOVE' });
    if (res && res.move) {
      const from = res.move.slice(0, 2).toUpperCase();
      const to = res.move.slice(2, 4).toUpperCase();
      status.innerHTML = '<span class="ok">✅ ' + from + ' → ' + to + '</span>';
    } else if (res && res.error) {
      status.innerHTML = '<span class="err">❌ ' + res.error + '</span>';
    } else {
      status.innerHTML = '<span class="err">No response</span>';
    }
  } catch (e) {
    status.innerHTML = '<span class="err">❌ ' + e.message + '</span>';
  }
});

document.getElementById('runDiag').addEventListener('click', async () => {
  const status = document.getElementById('status');
  status.textContent = 'Running diagnostics...';
  status.className = '';
  const tab = await getActiveTab();
  if (!tab || !isChessCom(tab.url)) {
    status.textContent = 'Open chess.com first';
    status.className = 'err';
    return;
  }
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'DIAGNOSTIC' });
    if (!res) { status.textContent = 'No response from page'; return; }
    status.textContent = formatDiag(res);
  } catch (e) {
    status.innerHTML = '<span class="err">❌ ' + e.message + '</span>';
  }
});

document.getElementById('checkServer').addEventListener('click', async () => {
  const status = document.getElementById('status');
  status.textContent = 'Pinging server...';
  status.className = '';
  try {
    const res = await fetch('http://localhost:8765/health');
    const data = await res.json();
    if (data.ok) status.innerHTML = '<span class="ok">✅ Server running (Stockfish ready)</span>';
    else status.innerHTML = '<span class="err">⚠️ Server up but Stockfish not ready</span>';
  } catch (e) {
    status.innerHTML = '<span class="err">❌ Server not running. Start it first.</span>';
  }
});

function formatDiag(d) {
  if (d.error) return 'ERROR: ' + d.error + (d.stack ? '\n' + d.stack : '');
  const lines = [];
  lines.push('URL: ' + (d.url || '').slice(-60));

  if (d.boardError) {
    lines.push('BOARD ERROR: ' + d.boardError);
    return lines.join('\n');
  }

  if (d.visibleBoard) {
    const v = d.visibleBoard;
    lines.push('BOARD: ' + v.tag + '.' + v.cls.substring(0, 40));
    lines.push('  ' + v.rect.w + 'x' + v.rect.h + ' at (' + v.rect.left + ',' + v.rect.top + ')');
  }

  lines.push('PIECES: ' + (d.pieceCount || 0));
  if (d.pieceSamples && d.pieceSamples.length) {
    lines.push('SAMPLES:');
    for (const p of d.pieceSamples) {
      lines.push('  ' + p.tag + '.' + p.cls.substring(0, 35));
      if (p.chesscom) lines.push('    chesscom: ' + p.chesscom);
      if (p.legacy) lines.push('    legacy: ' + p.legacy);
    }
  }

  if (d.domFen) {
    if (d.domFen.error) lines.push('FEN ERROR: ' + d.domFen.error);
    else {
      lines.push('FEN: ' + d.domFen.fenPos);
      lines.push('  source=' + d.domFen.source + ' flipped=' + d.domFen.flipped);
    }
  }

  if (d.clocks) lines.push('CLOCKS: top=' + (d.clocks.topMs / 1000).toFixed(0) + 's bottom=' + (d.clocks.bottomMs / 1000).toFixed(0) + 's');

  return lines.join('\n');
}

refreshAutoButton();
