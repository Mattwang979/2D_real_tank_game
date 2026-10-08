// Chinese UI screenshots: lobby menu, lobby room (host), battle HUD with tutorial.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const [out = '/tmp'] = process.argv.slice(2);
const BASE = (process.env.URL ?? 'http://localhost:5173/') + '?peerhost=127.0.0.1&peerport=9000&peerpath=/';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, locale: 'zh-TW' });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(BASE);
await page.waitForTimeout(800);
await page.evaluate(() => {
  const s = window.__pen.save();
  s.settings.lang = 'zh';
  s.stats.battles = 0;
});
await page.mouse.click(400, 200);
await page.waitForTimeout(700);
await page.screenshot({ path: `${out}/zh2_hangar.png` });
await page.evaluate(() => window.__pen.openLobby());
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/zh2_lobby_menu.png` });
await page.locator('.lb-card .btn.primary').first().click();
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/zh2_lobby_room.png` });
await page.evaluate(() => window.__pen.lobby.leaveRoom());
await page.evaluate(() => {
  window.__pen.save().settings.map = 'city';
});
await page.evaluate(() => window.__pen.startBattle());
await page.waitForTimeout(1000);
await page.evaluate(() => {
  window.__pen.battle.time = 6;
});
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/zh2_battle.png` });
await browser.close();
