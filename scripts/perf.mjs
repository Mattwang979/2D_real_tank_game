import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const [map = 'city', q = 'high', weather = 'clear'] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://localhost:5173/');
await page.waitForTimeout(600);
await page.evaluate(([m, q, w]) => { const s = window.__pen.save(); s.settings.map = m; s.settings.quality = q; s.settings.weather = w; }, [map, q, weather]);
await page.evaluate(() => window.__pen.startBattle());
await page.waitForTimeout(1500);
const r = await page.evaluate(async () => {
  const P = window.__pen; const b = P.battle; const hud = P.hud; const rd = P.renderer;
  const c = b.map.capture; b.player.pos.x = c.x - 40; b.player.pos.y = c.y;
  // fast-forward into combat
  for (let i = 0; i < 30 * 40; i++) { b.update(1 / 30); b.events.length = 0; }
  const T = { sim: 0, render: 0, hud: 0, vis: 0 };
  const N = 90;
  for (let i = 0; i < N; i++) {
    let t0 = performance.now();
    hud.update(1 / 60); b.update(1 / 60); for (const ev of b.events) hud.handle(ev); b.events.length = 0;
    let t1 = performance.now(); T.sim += t1 - t0;
    rd.render(1 / 60); let t2 = performance.now(); T.render += t2 - t1;
    hud.draw(rd.ctx); let t3 = performance.now(); T.hud += t3 - t2;
  }
  const t4 = performance.now();
  for (let i = 0; i < 30; i++) { const p = b.player; const vc = p.visionCone(); }
  return { sim: (T.sim / N).toFixed(2), render: (T.render / N).toFixed(2), hud: (T.hud / N).toFixed(2), tanks: b.tanks.length, parts: b.fx.parts.length, chunks: rd.mapR.chunks.size, canvas: [rd.canvas.width, rd.canvas.height] };
});
console.log(map, q, JSON.stringify(r));
await browser.close();
