// Hangar layout check on landscape phone sizes, in English and Chinese: the right-hand column
// (battle / multiplayer / map / weather / AI) and the vehicle info must end above the lineup bar,
// and the top bar items may not overlap or run off screen. Screenshots of each size.
// Needs `npm run dev`. Usage: node scripts/hangarlayout.mjs [outDir]
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const [out = '/tmp'] = process.argv.slice(2);
const URL = process.env.URL ?? 'http://localhost:5173/';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let ok = true;
const errors = [];
const check = (n, c, i = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${i}`);
  if (!c) ok = false;
};
for (const [w, hh] of [[568, 320], [640, 360], [667, 375], [740, 360], [844, 390], [932, 430]]) {
  for (const lang of ['en', 'zh']) {
    const ctx = await browser.newContext({ viewport: { width: w, height: hh }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, locale: lang === 'zh' ? 'zh-TW' : 'en-US' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(URL);
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      window.__pen.save().stats.battles = 5;
      window.__pen.show('hangar');
    });
    await page.waitForTimeout(400);
    const lay = await page.evaluate(() => {
      const r = (el) => el.getBoundingClientRect();
      const bottom = (sel) => Math.round(Math.max(...[...document.querySelector(sel).children].map((c) => r(c).bottom)));
      const top = [...document.querySelector('#hangar .topbar').children].map(r);
      return {
        actions: bottom('#hangar .actions'),
        info: bottom('#hangar .veh-info'),
        bar: Math.round(r(document.querySelector('#hangar .lineup-bar')).top),
        topOverlap: top.some((a, i) => top.some((b, j) => j > i && a.right > b.left + 1 && b.right > a.left + 1)),
        topRight: Math.round(Math.max(...top.map((k) => k.right))),
        vw: innerWidth,
      };
    });
    check(`${w}×${hh} ${lang}: columns above the lineup bar`, lay.actions <= lay.bar && lay.info <= lay.bar, `actions ${lay.actions} / info ${lay.info} / bar ${lay.bar}`);
    check(`${w}×${hh} ${lang}: top bar fits`, !lay.topOverlap && lay.topRight <= lay.vw, `right edge ${lay.topRight}/${lay.vw}`);
    await page.screenshot({ path: `${out}/hangar_${w}x${hh}_${lang}.png` });
    await ctx.close();
  }
}
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(ok ? 'ALL PASS' : 'SOME FAILED');
await browser.close();
process.exit(ok ? 0 : 1);
