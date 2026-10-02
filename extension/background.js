// Opens the panel as a narrow window docked to the right of the current
// browser window, so it doesn't cover the videos.
const WIDTH = 460;

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('panel.html');
  const existing = (await chrome.tabs.query({})).find(tab => tab.url === url);
  if (existing) {
    await chrome.windows.update(existing.windowId, { focused: true });
    await chrome.tabs.update(existing.id, { active: true });
    return;
  }
  const options = { url, type: 'popup', width: WIDTH, height: 860 };
  try {
    const current = await chrome.windows.getLastFocused();
    if (current.state === 'normal' || current.state === 'maximized') {
      Object.assign(options, { left: Math.max(0, current.left + current.width - WIDTH), top: current.top, height: current.height });
    }
  } catch { /* No window to align with. */ }
  await chrome.windows.create(options);
});
