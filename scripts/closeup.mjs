import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const [out, map = 'outpost'] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://localhost:5173/');
await page.waitForTimeout(600);
await page.evaluate((m) => { const s = window.__pen.save(); s.settings.map = m; s.lineup = ['pantherG','tiger1','is2']; s.stats.battles = 5; }, map);
await page.evaluate(() => window.__pen.startBattle());
await page.waitForTimeout(1500);
// stage a scene: player and an enemy close, enemy firing; kill one with a cook-off
await page.evaluate(() => {
  const b = window.__pen.battle; const p = b.player; const c = b.map.capture;
  p.pos = { x: c.x - 30, y: c.y + 12 }; p.ang = -0.3; p.aimAngle = 0.2;
  const enemies = b.tanks.filter(t => t.team !== p.team);
  enemies[0].pos = { x: c.x + 5, y: c.y - 2 }; enemies[0].ang = Math.PI - 0.2;
  enemies[1].pos = { x: c.x + 2, y: c.y + 22 }; enemies[1].ang = Math.PI + 0.4;
  for (const [id, ai] of b.ais) ai.update = () => {};
  window.__pen.hud.autoInput = (pp) => { pp.throttle = 0; pp.steer = 0; };
  window.__pen.hud.tutorial = 0;
});
await page.waitForTimeout(700);
await page.evaluate(() => { const b = window.__pen.battle; const e = b.tanks.filter(t => t.team !== b.playerTeam)[1]; b.kill(e, b.player, 'cookoff', null); b.player.reloadLeft = 0; b.playerFire(); });
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/closeup_${map}.png` });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/closeup2_${map}.png` });
await browser.close();
