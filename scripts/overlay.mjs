// Weak-spot overlay screenshots: an enemy placed in front of the player at normal and sniper zoom.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const [out = '/tmp'] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(process.env.URL ?? 'http://localhost:5173/');
await page.waitForTimeout(800);
await page.evaluate(() => {
  const s = window.__pen.save();
  s.settings.map = 'valley';
  s.lineup = ['pz4h'];
});
await page.evaluate(() => window.__pen.startBattle());
await page.waitForTimeout(1500);
await page.evaluate(() => {
  const b = window.__pen.battle;
  const p = b.player;
  b.ais.clear();
  b.checkEnd = () => {};
  const enemies = b.tanks.filter((t) => t.team !== p.team);
  for (const t of b.tanks) if (t !== p && t !== enemies[0]) { t.alive = false; t.pos = { x: 5 + Math.random() * 3, y: 5 }; }
  const e = enemies[0];
  // put the enemy 60 m ahead, angled 30° to the player
  e.pos = { x: p.pos.x + Math.cos(p.ang) * 60, y: p.pos.y + Math.sin(p.ang) * 60 };
  e.ang = p.ang + Math.PI + 0.5;
  e.vel = { x: 0, y: 0 };
  e.speed = 0;
  e.turretRel = -0.5;
  p.aimAngle = Math.atan2(e.pos.y - p.pos.y, e.pos.x - p.pos.x);
  p.turretRel = p.aimAngle - p.ang;
  window.__enemy = e;
  b.time = 6;
});
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/ov_normal.png` });
await page.evaluate(() => {
  window.__pen.renderer.zoomIdx = 3;
});
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/ov_sniper.png` });
const info = await page.evaluate(() => {
  const r = window.__pen.renderer;
  const b = window.__pen.battle;
  const p = b.player;
  const e = window.__enemy;
  return { pred: r.aimPrediction, z: r.zoomMul, spotted: b.isSpotted(p.team, e), alive: e.alive, epos: e.pos, ppos: p.pos, cam: r.cam, aimEnd: r.aimEnd, gun: p.gunWorldAng, aim: p.aimAngle, size: b.map.size };
});
console.log(JSON.stringify(info));
await browser.close();
