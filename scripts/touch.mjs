// Multi-touch control test via CDP touch events.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const [out] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://localhost:5173/');
await page.waitForTimeout(800);
const cdp = await ctx.newCDPSession(page);
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y, id]) => ({ x, y, id, radiusX: 5, radiusY: 5, force: 1 })) });
await touch('touchStart', [[420, 200, 1]]); await touch('touchEnd', []);
await page.waitForTimeout(600);
await page.evaluate(() => { window.__pen.save().settings.map = 'valley'; });
await page.evaluate(() => window.__pen.startBattle());
await page.waitForTimeout(1800);
const st0 = await page.evaluate(() => { const p = window.__pen.battle.player; return { ang: p.ang, pos: [p.pos.x, p.pos.y], reload: p.reloadLeft }; });
console.log('start', JSON.stringify(st0));
// left stick: push toward screen-up (north), right stick: drag right then release
await touch('touchStart', [[160, 300, 1]]);
for (let i = 1; i <= 8; i++) { await touch('touchMove', [[160, 300 - i * 9, 1]]); await page.waitForTimeout(30); }
await page.waitForTimeout(400);
await touch('touchStart', [[160, 228, 1], [600, 220, 2]]);
for (let i = 1; i <= 8; i++) { await touch('touchMove', [[160, 228, 1], [600 + i * 10, 220 - i * 4, 2]]); await page.waitForTimeout(30); }
await page.waitForTimeout(1500);
const mid = await page.evaluate(() => { const p = window.__pen.battle.player; const h = window.__pen.hud; return { ang: +p.ang.toFixed(2), aim: +p.aimAngle.toFixed(2), speed: +p.speed.toFixed(2), throttle: p.throttle, steer: +p.steer.toFixed(2), move: !!h.move, aimStick: !!h.aim, reload: +p.reloadLeft.toFixed(2) }; });
console.log('mid', JSON.stringify(mid));
await page.screenshot({ path: `${out}/touch_mid.png` });
// release aim stick → should fire (if reloaded)
await page.evaluate(() => { window.__pen.battle.player.reloadLeft = 0; });
await touch('touchEnd', [[160, 228, 1]]);
await page.waitForTimeout(120);
const fired = await page.evaluate(() => { const b = window.__pen.battle; return { proj: b.projectiles.filter(p => p.shooter.isPlayer).length, shots: b.stats.shots }; });
console.log('after release', JSON.stringify(fired));
await page.waitForTimeout(200);
await page.screenshot({ path: `${out}/touch_fire.png` });
await touch('touchEnd', []);
// quick tap on right side fires
await page.evaluate(() => { window.__pen.battle.player.reloadLeft = 0; });
await touch('touchStart', [[700, 150, 3]]); await page.waitForTimeout(60); await touch('touchEnd', []);
await page.waitForTimeout(100);
console.log('tap', JSON.stringify(await page.evaluate(() => window.__pen.battle.stats.shots)));
// fire button
await page.evaluate(() => { window.__pen.battle.player.reloadLeft = 0; });
const fb = await page.evaluate(() => { const h = window.__pen.hud; return h.buttons.find(b => b.id === 'fire'); });
await touch('touchStart', [[fb.x, fb.y, 4]]); await page.waitForTimeout(60); await touch('touchEnd', []);
await page.waitForTimeout(100);
console.log('firebtn', JSON.stringify(await page.evaluate(() => window.__pen.battle.stats.shots)));
const end = await page.evaluate(() => { const p = window.__pen.battle.player; return { ang: +p.ang.toFixed(2), pos: [p.pos.x|0, p.pos.y|0] }; });
console.log('end', JSON.stringify(end));
await browser.close();
