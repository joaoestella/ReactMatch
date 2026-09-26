chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('panel.html');
  const existing = (await chrome.tabs.query({})).find(tab => tab.url === url);
  if (existing) {
    await chrome.windows.update(existing.windowId, { focused: true });
    await chrome.tabs.update(existing.id, { active: true });
  } else {
    await chrome.windows.create({ url, type: 'popup', width: 1160, height: 900 });
  }
});
