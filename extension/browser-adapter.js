export class BrowserAdapter {
  async tabs() {
    const tabs = await chrome.tabs.query({});
    return tabs.filter(tab => /^https?:\/\//.test(tab.url || '')).map(tab => ({ id: tab.id, title: tab.title || tab.url, url: tab.url }));
  }
  async connect(tabId) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['media-bridge.js'] });
    const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: () => globalThis.__syncVideoBridge.list() });
    if (!result.result?.length) throw new Error('Nenhum vídeo acessível. Dê play na página e tente novamente. Players dentro de iframes não são suportados nesta versão.');
    return result.result;
  }
  async command(source, operation, value) {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: source.tabId },
      func: async (id, op, val) => {
        try { return { ok: true, data: await globalThis.__syncVideoBridge.run(id, op, val) }; }
        catch (error) { return { ok: false, message: error.message }; }
      }, args: [source.videoId, operation, value ?? null]
    });
    if (!result.result?.ok) throw new Error(result.result?.message || 'Não foi possível acessar o vídeo. Reconecte a aba.');
    return result.result.data;
  }
}
