import { t } from './i18n.js';

export class DemoAdapter {
  constructor() {
    this.media = { 1: { time: 494, paused: true }, 2: { time: 508, paused: true } };
    this.last = performance.now();
  }
  step() {
    const now = performance.now();
    const elapsed = (now - this.last) / 1000;
    for (const video of Object.values(this.media)) if (!video.paused) video.time += elapsed;
    this.last = now;
  }
  async tabs() { return [{ id: 1, title: t('demo.original'), url: 'demo:original' }, { id: 2, title: t('demo.reaction'), url: 'demo:reaction' }]; }
  async connect(tabId) { return { videos: [{ ...(await this.command({ tabId, videoId: 'demo' }, 'snapshot')), frameId: 0 }], missing: [] }; }
  async command(source, operation, value) {
    this.step();
    if (operation === 'grab') return { error: 'demo' };
    const video = this.media[source.tabId];
    if (operation === 'seek') video.time = value;
    if (operation === 'pause') video.paused = true;
    if (operation === 'play') video.paused = false;
    return { ...video, id: 'demo', duration: 3600, ready: 4, rate: 1, seeking: false, ended: false, ranges: [[0, 3600]], source: `demo-${source.tabId}`, sampledAt: Date.now() };
  }
}
