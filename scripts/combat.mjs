// Fast-forward to combat and capture screenshots. node scripts/combat.mjs <outdir> <map> [shots]
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const [out, map = 'valley', nshots = '4'] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message, e.stack?.split('\n').slice(0, 5).join(' | ')));
await page.goto('http://localhost:5173/');
await page.waitForTimeout(800);
await page.evaluate((m) => { const s = window.__pen.save(); s.settings.map = m; s.lineup = ['tiger1','is2','pantherG']; }, map);
await page.evaluate(() => window.__pen.startBattle());
await page.waitForTimeout(1500);
await page.evaluate(() => {
  const P = window.__pen; const b = P.battle; const hud = P.hud;
  window.__auto = true;
  const p0 = b.player; const c0 = b.map.capture; p0.pos.x = c0.x + (b.playerTeam === 0 ? -45 : 45); p0.pos.y = c0.y + 8;
  hud.autoInput = (p) => {
    const c = b.map.capture; const want = Math.atan2(c.y - p.pos.y, c.x - p.pos.x);
    let d = want - p.ang; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    const far = Math.hypot(c.x - p.pos.x, c.y - p.pos.y) > 35;
    p.throttle = far ? 0.8 : 0; p.steer = Math.max(-1, Math.min(1, d * 2));
    let best = null, bd = 1e9;
    for (const e of b.tanks) { if (!e.alive || e.team === p.team || !b.isSpotted(p.team, e)) continue; const dd = Math.hypot(e.pos.x - p.pos.x, e.pos.y - p.pos.y); if (dd < bd) { bd = dd; best = e; } }
    const clear = (e) => { const m = p.muzzle(); for (const o of b.tanks) { if (o === p || o.team !== p.team || !o.alive) continue; const ax = e.pos.x - m.x, ay = e.pos.y - m.y; const l2 = ax*ax+ay*ay; let t = ((o.pos.x-m.x)*ax + (o.pos.y-m.y)*ay)/l2; if (t < 0 || t > 1) continue; const dx = m.x + ax*t - o.pos.x, dy = m.y + ay*t - o.pos.y; if (Math.hypot(dx,dy) < 4) return false; } return true; };
    if (best) { p.aimAngle = Math.atan2(best.pos.y - p.pos.y, best.pos.x - p.pos.x); if (p.isReloaded() && p.aimError() < 0.015 && clear(best)) b.playerFire(); }
    else p.aimAngle = want;
  };
});
let shot = 0;
for (let k = 0; k < 40 && shot < +nshots; k++) {
  // fast forward up to 6 sim-seconds or until the player lands a hit
  const r = await page.evaluate(() => {
    const P = window.__pen; const b = P.battle; const hud = P.hud; if (!b) return 'none';
    for (let i = 0; i < 180; i++) {
      hud.update(1 / 30); b.update(1 / 30);
      let hit = false;
      for (const ev of b.events) { hud.handle(ev); if (ev.type === 'hit' && ev.shooter.isPlayer) hit = true; if (ev.type === 'playerDead') { const av = b.availableLineup(); b.local.deadAt = -10; if (av.length) b.respawnPlayer(av[0].id); } }
      b.events.length = 0;
      if (hit) return 'hit';
      if (b.state === 'ended') return 'ended';
    }
    return 'time';
  });
  if (r === 'hit') {
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${out}/combat_${map}_${shot++}.png` });
  } else if (r === 'ended' || r === 'none') break;
}
if (shot === 0) await page.screenshot({ path: `${out}/combat_${map}_none.png` });
console.log('shots', shot);
await browser.close();
