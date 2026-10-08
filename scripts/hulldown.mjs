// Hull-down test: target parked right behind a ridge, shooter in front; low shells must bury in the
// berm, only turret hits get through. Also screenshots of the earthworks.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const [out = '/tmp', map = 'valley'] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(process.env.URL ?? 'http://localhost:5173/');
await page.waitForTimeout(700);
await page.evaluate((m) => {
  const s = window.__pen.save();
  s.settings.map = m;
  s.stats.battles = 5;
  s.lineup = ['pz4h'];
}, map);
await page.evaluate(() => window.__pen.startBattle());
await page.waitForTimeout(1200);
const info = await page.evaluate(() => {
  const b = window.__pen.battle;
  return { berms: b.map.berms.length, kinds: b.map.berms.map((x) => x.kind).join(','), spots: b.map.hullDown.length };
});
console.log('earthworks', JSON.stringify(info));
const res = await page.evaluate(() => {
  const b = window.__pen.battle;
  const p = b.player;
  b.ais.clear();
  b.checkEnd = () => {};
  const ridge = b.map.berms.find((x) => x.kind === 'ridge');
  const i = Math.floor(ridge.pts.length / 2) - 1;
  const a = ridge.pts[i];
  const c = ridge.pts[i + 1];
  const mx = (a.x + c.x) / 2;
  const my = (a.y + c.y) / 2;
  const L = Math.hypot(c.x - a.x, c.y - a.y);
  const nx = -(c.y - a.y) / L;
  const ny = (c.x - a.x) / L;
  const e = b.tanks.find((t) => t.team !== p.team);
  for (const t of b.tanks) if (t !== p && t !== e) t.pos = { x: 5, y: 5 + t.id * 9 };
  // keep only the earthwork under test so another bank in the line of fire doesn't skew the count
  b.map.berms = [ridge];
  // target 3.6 m behind the crest, facing across it; shooter 70 m in front
  e.pos = { x: mx + nx * 3.6, y: my + ny * 3.6 };
  e.ang = Math.atan2(-ny, -nx);
  e.turretRel = 0;
  p.pos = { x: mx - nx * 70, y: my - ny * 70 };
  p.ang = Math.atan2(ny, nx);
  for (const t of [e, p]) {
    t.speed = 0;
    t.vel = { x: 0, y: 0 };
    t.throttle = 0;
    t.steer = 0;
  }
  b.spotted[p.team].add(e.id);
  window.__setup = { e: e.id, mx, my, nx, ny };
  const out = { turret: 0, hull: 0, other: 0, shots: 0, hullH: [] };
  const covered = window.__pen.battle.map && true;
  for (let k = 0; k < 80; k++) {
    for (const m of e.mods) m.hp = m.def.maxHp;
    e.alive = true;
    e.burning = 0;
    e.turretOff = null;
    e.cookedOff = false;
    e.aimAngle = e.ang;
    e.pos = { x: mx + nx * 3.6, y: my + ny * 3.6 };
    e.ang = Math.atan2(-ny, -nx);
    p.pos = { x: mx - nx * 70, y: my - ny * 70 };
    p.aimAngle = Math.atan2(e.pos.y - p.pos.y, e.pos.x - p.pos.x);
    p.turretRel = p.aimAngle - p.ang;
    p.reloadLeft = 0;
    p.bloom = 0;
    p.wantFire = true;
    for (let s = 0; s < 20; s++) {
      b.update(1 / 30);
      const pr = b.projectiles.find((q) => q.shooter === p);
      if (pr) window.__lastH = pr.height;
      for (const ev of b.events) {
        if (ev.type !== 'hit' || ev.shooter !== p) continue;
        if (ev.target !== e) {
          out.other++;
          continue;
        }
        const key = ev.res.plateKey ?? '';
        if (key.startsWith('t') || key === 'mantlet') out.turret++;
        else if (key) {
          out.hull++;
          out.hullH.push(+window.__lastH.toFixed(2));
        }
        else out.other++;
      }
      b.events.length = 0;
    }
    out.shots++;
  }
  return out;
});
console.log('hull-down shots', JSON.stringify(res));
// screenshot: zoom in on the hull-down target with the overlay
await page.evaluate(() => {
  const b = window.__pen.battle;
  const p = b.player;
  const s = window.__setup;
  const e = b.tanks.find((t) => t.id === s.e);
  for (const m of e.mods) m.hp = m.def.maxHp;
  e.alive = true;
  e.turretOff = null;
  p.aimAngle = Math.atan2(e.pos.y - p.pos.y, e.pos.x - p.pos.x);
  p.reloadLeft = 5;
  b.time = 6;
  window.__pen.renderer.zoomIdx = 3;
});
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/hd_sniper.png` });
console.log(JSON.stringify(await page.evaluate(() => window.__pen.renderer.aimPrediction)));
await page.evaluate(() => {
  window.__pen.renderer.zoomIdx = 0;
});
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/hd_wide.png` });
await browser.close();
