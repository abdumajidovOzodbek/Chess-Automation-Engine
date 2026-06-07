async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refreshAutoButton() {
  const adviseBtn = document.getElementById('autoToggle');
  const playBtn = document.getElementById('autoplayToggle');
  const preBtn = document.getElementById('premoveToggle');
  const warn = document.getElementById('autoplayWarning');
  const tab = await getActiveTab();
  if (!tab || !tab.url || !tab.url.includes('chessfriends.com')) {
    adviseBtn.textContent = 'Open chessfriends.com first';
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
    setThinkButtons((res && res.forcedMovetime) || 0);
    warn.style.display = (res && res.autoPlay) ? 'block' : 'none';
  } catch (e) {
    setAdviseBtn(false);
    setPlayBtn(false, false);
    setPreBtn(false, false);
    setThinkButtons(0);
  }
}

function setThinkButtons(currentMs) {
  const valEl = document.getElementById('thinkVal');
  if (valEl) valEl.textContent = currentMs === 0 ? 'AUTO (clock)' : (currentMs >= 1000 ? (currentMs / 1000) + 's' : currentMs + 'ms');
  const btns = document.querySelectorAll('.time-btn');
  btns.forEach(b => {
    const ms = parseInt(b.getAttribute('data-ms'), 10);
    if (ms === currentMs) b.classList.add('active');
    else b.classList.remove('active');
  });
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
  if (on) {
    btn.textContent = '✅ Auto-Advise: ON';
    btn.className = '';
  } else {
    btn.textContent = '▶️ Turn Auto-Advise ON';
    btn.className = 'off';
  }
}

function setPlayBtn(on, adviseOn) {
  const btn = document.getElementById('autoplayToggle');
  btn.disabled = !adviseOn;
  if (!adviseOn) {
    btn.textContent = '🤖 Auto-Play (needs Advise ON)';
    btn.className = 'off';
    return;
  }
  if (on) {
    btn.textContent = '🤖 AUTO-PLAY: ON (clicks moves)';
    btn.className = 'danger';
  } else {
    btn.textContent = '🤖 Turn Auto-Play ON';
    btn.className = 'off';
  }
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
    if (!cur || !cur.autoMode) return; // requires advise on
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

document.querySelectorAll('.time-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const ms = parseInt(btn.getAttribute('data-ms'), 10);
    const tab = await getActiveTab();
    if (!tab) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'SET_FORCED_MOVETIME', value: ms });
      await refreshAutoButton();
    } catch (e) {
      document.getElementById('status').textContent = 'Error: ' + e.message;
    }
  });
});

document.getElementById('getMove').addEventListener('click', async () => {
  const status = document.getElementById('status');
  status.textContent = 'Sending request...';
  status.className = '';
  const tab = await getActiveTab();
  if (!tab || !tab.url || !tab.url.includes('chessfriends.com')) {
    status.textContent = 'Open chessfriends.com first';
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
  if (!tab || !tab.url || !tab.url.includes('chessfriends.com')) {
    status.textContent = 'Open chessfriends.com first';
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
    if (data.ok) {
      status.innerHTML = '<span class="ok">✅ Server running (Stockfish ready)</span>';
    } else {
      status.innerHTML = '<span class="err">⚠️ Server up but Stockfish not ready</span>';
    }
  } catch (e) {
    status.innerHTML = '<span class="err">❌ Server not running. Start it first.</span>';
  }
});

function formatDiag(d) {
  if (d.error) return 'ERROR: ' + d.error + (d.stack ? '\n' + d.stack : '');
  const lines = [];
  lines.push('URL: ' + (d.url || '').slice(-50));

  if (d.boardError) {
    lines.push('BOARD ERROR: ' + d.boardError);
    return lines.join('\n');
  }

  if (d.visibleBoard) {
    const v = d.visibleBoard;
    lines.push('BOARD: ' + v.tag + '.' + v.cls.substring(0, 40));
    lines.push('  ' + v.rect.w + 'x' + v.rect.h + ' at (' + v.rect.left + ',' + v.rect.top + ')');
  }

  lines.push('PIECES FOUND: ' + (d.pieceCount || 0));
  if (d.domFen) {
    if (d.domFen.error) {
      lines.push('DOM FEN ERROR: ' + d.domFen.error);
    } else {
      lines.push('DOM FEN: ' + d.domFen.fenPos);
      lines.push('  flipped=' + d.domFen.flipped);
    }
  }

  return lines.join('\n');
}

refreshAutoButton();
