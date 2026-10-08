import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const [out] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
for (const [w, h, name] of (process.env.SIZES ? JSON.parse(process.env.SIZES) : [[667, 375, 'se'], [932, 430, 'promax']])) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto('http://localhost:5173/');
  await page.waitForTimeout(600);
  await page.mouse.click(w / 2, h / 2);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/size_${name}_hangar.png` });
  await page.evaluate(() => { window.__pen.save().settings.map = 'outpost'; });
  await page.evaluate(() => window.__pen.startBattle());
  await page.waitForTimeout(1800);
  await page.evaluate(() => { const b = window.__pen.battle; const p = b.player; p.burning = 5; });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/size_${name}_battle.png` });
  await ctx.close();
}
await browser.close();
