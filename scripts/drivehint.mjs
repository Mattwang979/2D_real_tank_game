// Screenshot of the drive hints: stick pushed sideways, then into the reverse zone.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const [out = '/tmp'] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(process.env.URL ?? 'http://localhost:5173/');
await page.waitForTimeout(700);
const cdp = await ctx.newCDPSession(page);
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y, id]) => ({ x, y, id, radiusX: 5, radiusY: 5, force: 1 })) });
await page.evaluate(() => {
  const s = window.__pen.save();
  s.settings.map = 'valley';
  s.stats.battles = 5;
});
await page.evaluate(() => window.__pen.startBattle());
await page.waitForTimeout(1200);
await page.evaluate(() => {
  const b = window.__pen.battle;
  b.time = 6;
  b.ais.clear();
});
// push the stick up (north) while the tank faces east
await touch('touchStart', [[160, 300, 1]]);
for (let i = 1; i <= 6; i++) {
  await touch('touchMove', [[160 + i * 2, 300 - i * 9, 1]]);
  await page.waitForTimeout(25);
}
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/drive_turn.png` });
// pull back (reverse zone)
for (let i = 1; i <= 8; i++) {
  await touch('touchMove', [[160 - i * 7, 300 + 2, 1]]);
  await page.waitForTimeout(25);
}
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/drive_reverse.png` });
console.log(JSON.stringify(await page.evaluate(() => ({ rev: window.__pen.hud.reverseMode, th: window.__pen.battle.player.throttle, sp: window.__pen.battle.player.speed }))));
await touch('touchEnd', []);
await browser.close();
