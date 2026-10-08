// Mobile-landscape smoke test. Usage: node scripts/play.mjs <outdir> [scenario]
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const [out, scenario = 'basic', url = 'http://localhost:5173/'] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') { errors.push(m.text()); console.log('[console.error]', m.text()); } });
page.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.message, e.stack?.split('\n').slice(0,4).join(' | ')); });
await page.goto(url);
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/01_title.png` });
await page.mouse.click(420, 200);
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/02_hangar.png` });
if (scenario === 'menus') {
  await page.evaluate(() => window.__pen.show('tree'));
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/03_tree.png` });
  await browser.close();
  process.exit(0);
}
const map = process.env.MAP || 'valley';
await page.evaluate((m) => { const s = window.__pen.save(); s.settings.map = m; }, map);
await page.evaluate(() => window.__pen.startBattle());
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/03_battle_start.png` });
// drive forward toward the capture point and shoot at things
const t0 = Date.now();
for (let i = 0; i < 24; i++) {
  await page.evaluate(() => {
    const b = window.__pen.battle; if (!b || !b.player) return;
    const p = b.player; const c = b.map.capture;
    const want = Math.atan2(c.y - p.pos.y, c.x - p.pos.x);
    let d = want - p.ang; while (d > Math.PI) d -= 2*Math.PI; while (d < -Math.PI) d += 2*Math.PI;
    p.throttle = 1; p.steer = Math.max(-1, Math.min(1, d * 2));
    // aim at nearest spotted enemy
    let best = null, bd = 1e9;
    for (const e of b.tanks) { if (!e.alive || e.team === p.team || !b.isSpotted(p.team, e)) continue; const dd = Math.hypot(e.pos.x-p.pos.x, e.pos.y-p.pos.y); if (dd < bd) { bd = dd; best = e; } }
    if (best) { p.aimAngle = Math.atan2(best.pos.y - p.pos.y, best.pos.x - p.pos.x); if (p.isReloaded() && p.aimError() < 0.02) b.playerFire(); }
  });
  await page.waitForTimeout(500);
  if (i === 10) await page.screenshot({ path: `${out}/04_battle_mid.png` });
}
await page.screenshot({ path: `${out}/05_battle_late.png` });
const info = await page.evaluate(() => { const b = window.__pen.battle; if (!b) return 'no battle'; return { t: b.time.toFixed(1), state: b.state, tickets: b.tickets.map(Math.round), alive: b.tanks.filter(t=>t.alive).map(t=>`${t.team}:${t.spec.id}`).join(' '), dead: b.tanks.filter(t=>!t.alive).length, proj: b.projectiles.length, cap: b.capture, stats: b.stats, parts: b.fx.parts.length, player: b.player && { alive: b.player.alive, pos: [b.player.pos.x|0, b.player.pos.y|0] } }; });
console.log(JSON.stringify(info));
console.log('errors:', errors.length);
await browser.close();
