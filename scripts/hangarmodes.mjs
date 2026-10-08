import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const [out] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://localhost:5173/');
await page.waitForTimeout(600);
await page.evaluate(() => { const s = window.__pen.save(); s.owned.push('tiger1', 'is2'); s.lineup = ['tiger1', 'is2', 'm4a2']; s.selected = 'tiger1'; });
await page.mouse.click(420, 200);
await page.waitForTimeout(600);
for (const [mode, sel] of [['armor', 'Armor'], ['xray', 'X-Ray']]) {
  await page.locator('#hangar .viewmodes button', { hasText: sel }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/hangar_${mode}.png`, clip: { x: 260, y: 40, width: 330, height: 270 } });
}
await page.locator('#hangar .slot', { hasText: 'IS-2' }).click();
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/hangar_xray_is2.png`, clip: { x: 260, y: 40, width: 330, height: 270 } });
await browser.close();
