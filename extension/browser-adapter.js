// Talks to the players of real tabs through media-bridge.js, which is
// injected into the page and into every embedded frame we have access to.

import { t } from './i18n.js';

const ERRORS = {
  'player-changed': 'bridge.playerChanged',
  'play-blocked': 'bridge.playBlocked',
  'not-seekable': 'bridge.notSeekable'
};

export class BrowserAdapter {
  async tabs() {
    const tabs = await chrome.tabs.query({});
    return tabs.filter(tab => /^https?:\/\//.test(tab.url || '')).map(tab => ({ id: tab.id, title: tab.title || tab.url, url: tab.url }));
  }

  // Returns every video found in the tab (each tagged with its frame) and the
  // origins of embedded players we still need permission for.
  async connect(tabId) {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['media-bridge.js'] });
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true }, func: () => globalThis.__reactMatchBridge?.list()
    });
    const videos = [], reached = new Set(), children = new Set();
    for (const { frameId, result } of results) {
      if (!result) continue;
      reached.add(result.origin);
      result.children.forEach(origin => children.add(origin));
      for (const video of result.videos) videos.push({ ...video, frameId });
    }
    const missing = [];
    for (const origin of children) {
      if (reached.has(origin)) continue;
      if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) missing.push(origin);
    }
    videos.sort((a, b) => b.area - a.area);
    return { videos, missing };
  }

  async command(source, operation, value) {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: source.tabId, frameIds: [source.frameId ?? 0] },
      func: async (id, op, val) => {
        try { return { ok: true, data: await globalThis.__reactMatchBridge.run(id, op, val) }; }
        catch (error) { return { ok: false, message: error.message }; }
      }, args: [source.videoId, operation, value ?? null]
    });
    if (!result?.result?.ok) {
      const code = result?.result?.message;
      throw new Error(t(ERRORS[code] || 'bridge.failed'));
    }
    return result.result.data;
  }
}
