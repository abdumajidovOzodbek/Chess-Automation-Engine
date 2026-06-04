chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'get-best-move') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'GET_BEST_MOVE' });
  } catch (e) {
    console.warn('Could not send message:', e);
  }
});
