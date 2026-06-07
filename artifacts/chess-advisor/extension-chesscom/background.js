// background.js — service worker
//
// Two responsibilities:
//   1. Forward the Ctrl+Shift+B hotkey to the active tab's content script.
//   2. Provide a TRUSTED-EVENT click path via chrome.debugger (CDP).
//      Synthetic events from content scripts have isTrusted=false and many
//      chess platforms ignore them. CDP's Input.dispatchMouseEvent generates
//      events that are indistinguishable from real user clicks, including
//      isTrusted=true. Cost: a yellow "being debugged" banner appears.

const debugTargets = new Map(); // tabId -> { attached: bool }

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'get-best-move') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'GET_BEST_MOVE' });
  } catch (e) {}
});

async function attach(tabId) {
  if (debugTargets.has(tabId) && debugTargets.get(tabId).attached) return true;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    debugTargets.set(tabId, { attached: true });
    return true;
  } catch (e) {
    // Already attached (by DevTools or another extension) → can't proceed
    console.warn('debugger attach failed:', e && e.message);
    return false;
  }
}

async function detach(tabId) {
  const info = debugTargets.get(tabId);
  if (!info || !info.attached) return;
  try { await chrome.debugger.detach({ tabId }); } catch (e) {}
  debugTargets.set(tabId, { attached: false });
}

// Clean up on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  debugTargets.delete(tabId);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId != null) {
    debugTargets.set(source.tabId, { attached: false });
    console.log('debugger detached, reason=' + reason);
  }
});

// Receive real-click requests from the content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'TRUSTED_DRAG') {
    handleTrustedDrag(sender.tab.id, msg).then(sendResponse).catch((e) => {
      sendResponse({ ok: false, error: String(e) });
    });
    return true;
  }
  if (msg.type === 'TRUSTED_CLICK_MOVE') {
    handleTrustedClickMove(sender.tab.id, msg).then(sendResponse).catch((e) => {
      sendResponse({ ok: false, error: String(e) });
    });
    return true;
  }
  if (msg.type === 'TRUSTED_DETACH') {
    detach(sender.tab.id).then(() => sendResponse({ ok: true }));
    return true;
  }
});

async function handleTrustedClickMove(tabId, msg) {
  if (!msg || typeof msg.from !== 'object' || typeof msg.to !== 'object') {
    return { ok: false, error: 'bad coords' };
  }
  // Reject obviously-broken coordinates so the caller knows something's wrong
  if (msg.from.x <= 0 || msg.from.y <= 0 || msg.to.x <= 0 || msg.to.y <= 0) {
    return { ok: false, error: 'invalid coords (' + msg.from.x + ',' + msg.from.y + ')→(' + msg.to.x + ',' + msg.to.y + ')' };
  }
  const ok = await attach(tabId);
  if (!ok) return { ok: false, error: 'attach-failed' };

  const { from, to } = msg;

  const dispatch = (params) =>
    chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', params);

  try {
    // CLICK 1: at source square
    await dispatch({ type: 'mouseMoved', x: from.x, y: from.y, button: 'none', buttons: 0 });
    await sleep(15);
    await dispatch({ type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, buttons: 1 });
    await sleep(20);
    await dispatch({ type: 'mouseReleased', x: from.x, y: from.y, button: 'left', clickCount: 1, buttons: 0 });
    // Brief pause so chessground processes "selection" before we click destination
    await sleep(60);
    // CLICK 2: at destination square
    await dispatch({ type: 'mouseMoved', x: to.x, y: to.y, button: 'none', buttons: 0 });
    await sleep(15);
    await dispatch({ type: 'mousePressed', x: to.x, y: to.y, button: 'left', clickCount: 1, buttons: 1 });
    await sleep(20);
    await dispatch({ type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1, buttons: 0 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function handleTrustedDrag(tabId, msg) {
  if (!msg || typeof msg.from !== 'object' || typeof msg.to !== 'object') {
    return { ok: false, error: 'bad coords' };
  }
  const ok = await attach(tabId);
  if (!ok) return { ok: false, error: 'attach-failed' };

  const { from, to } = msg;

  const dispatch = (type, x, y, button = 'left', clickCount = 0) =>
    chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type, x, y, button, clickCount, buttons: type === 'mouseReleased' ? 0 : 1,
    });

  try {
    // Move to source first (so hover/element-binding triggers)
    await dispatch('mouseMoved', from.x, from.y, 'none');
    await sleep(20);
    // Press at source
    await dispatch('mousePressed', from.x, from.y, 'left', 1);
    await sleep(30);
    // Drag in 8 steps
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const p = i / steps;
      const x = from.x + (to.x - from.x) * p;
      const y = from.y + (to.y - from.y) * p;
      await dispatch('mouseMoved', x, y, 'left');
      await sleep(12);
    }
    // Release at destination
    await dispatch('mouseReleased', to.x, to.y, 'left', 1);
    await sleep(15);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
