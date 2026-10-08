import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const [map = 'valley'] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
await page.goto('http://localhost:5173/');
await page.waitForTimeout(600);
await page.evaluate((m) => { window.__pen.save().settings.map = m; }, map);
await page.evaluate(() => window.__pen.startBattle());
await page.waitForTimeout(1500);
const r = await page.evaluate(async () => {
  const P = window.__pen; const b = P.battle; const rd = P.renderer; const mr = rd.mapR;
  const c = b.map.capture; b.player.pos.x = c.x - 40; b.player.pos.y = c.y;
  for (let i = 0; i < 30 * 30; i++) { b.update(1 / 30); b.events.length = 0; }
  const T = {};
  const wrap = (obj, name, label) => { const f = obj[name].bind(obj); obj[name] = (...a) => { const t = performance.now(); const r = f(...a); T[label] = (T[label] || 0) + performance.now() - t; return r; }; };
  wrap(mr, 'drawGround', 'ground'); wrap(mr, 'drawTrees', 'trees'); wrap(mr, 'drawTreeShadows', 'treeShadows'); wrap(mr, 'drawBuildings', 'buildings'); wrap(mr, 'drawWalls', 'walls');
  wrap(b.fx, 'draw', 'fx'); wrap(rd, 'drawFog', 'fog'); wrap(rd, 'drawOverlays', 'overlays'); wrap(rd, 'drawTank', 'tanks'); wrap(rd, 'drawTankShadow', 'tankShadows');
  for (let i = 0; i < 10; i++) rd.render(1/60);
  for (const k in T) T[k] = 0;
  const N = 60; const t0 = performance.now();
  for (let i = 0; i < N; i++) { b.update(1/60); b.events.length = 0; rd.render(1 / 60); }
  const tot = (performance.now() - t0) / N;
  const out = { total: tot.toFixed(2) };
  for (const k in T) out[k] = (T[k] / N).toFixed(2);
  out.trees = out.trees + ` (${b.map.trees.length} trees)`;
  return out;
});
console.log(map, JSON.stringify(r));
await browser.close();
