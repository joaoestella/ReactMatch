const { chromium } = require('playwright'); const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, 'html'), out = path.join(__dirname, 'out');
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM });
  const sizes = [...JSON.parse(fs.readFileSync(path.join(dir, 'jobs.json'))).map(j => [j, 1280, 800]), ['promo-small-440x280', 440, 280], ['promo-marquee-1400x560-en', 1400, 560], ['promo-marquee-1400x560-pt', 1400, 560], ['social-1280x640', 1280, 640]];
  for (const [j, w, h] of sizes) {
    const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
    await p.goto('file://' + path.join(dir, j + '.html')); await p.waitForTimeout(300);
    await p.screenshot({ path: path.join(out, j + '@2x.png') }); await p.close();
  }
  await b.close();
})();
