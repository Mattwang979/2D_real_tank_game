import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const [out, lang = 'en'] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message, e.stack?.split('\n').slice(0,4).join(' | ')));
await page.goto('http://localhost:5173/');
await page.waitForTimeout(600);
await page.evaluate((l) => { const s = window.__pen.save(); s.settings.lang = l; s.settings.map = 'outpost'; }, lang);
await page.mouse.click(400, 200);
await page.waitForTimeout(500);
await page.evaluate(() => window.__pen.startBattle());
await page.waitForTimeout(1500);
// simulate being penetrated by an enemy shell
await page.evaluate(async () => {
  const P = window.__pen; const b = P.battle; const p = b.player;
  const e = b.tanks.find(t => t.team !== p.team);
  e.pos.x = p.pos.x + 60; e.pos.y = p.pos.y + 25;
  const armor = await import('/src/game/armor.ts');
  let res = null;
  for (let k = 0; k < 6 && p.alive; k++) {
    const from = e.muzzle(); const dir = { x: (p.pos.x - from.x), y: (p.pos.y - from.y) }; const l = Math.hypot(dir.x, dir.y); dir.x /= l; dir.y /= l;
    const hit = armor.intersectTank(p, from, { x: from.x + dir.x * 200, y: from.y + dir.y * 200 }, 0.9, 1, true);
    if (!hit) continue;
    res = armor.resolveImpact(e, p, e.spec.gun.shells[0], hit, 60, dir);
    b.events.push({ type: 'hit', res, shooter: e, target: p });
    if (res.killed) { b.kill(p, e, res.cookoff ? 'cookoff' : 'crew', res); break; }
  }
  if (p.alive) { for (const m of p.mods) if (m.def.kind === 'crew') m.hp = 0; b.kill(p, e, 'crew', res); }
});
await page.waitForTimeout(3200);
await page.screenshot({ path: `${out}/death_${lang}.png` });
const btn = await page.evaluate(() => window.__pen.hud.buttons.find(b => b.id.startsWith('spawn:')));
console.log('spawn button', JSON.stringify(btn));
if (btn) { await page.mouse.click(btn.x + btn.w / 2, btn.y + btn.h / 2); await page.waitForTimeout(800); console.log('respawned as', await page.evaluate(() => window.__pen.battle.player.spec.id + ' alive=' + window.__pen.battle.player.alive)); }
await page.screenshot({ path: `${out}/respawn_${lang}.png` });
await page.evaluate(() => { const b = window.__pen.battle; b.addReward(b.local, 'Target destroyed', 300, 1500); b.stats.kills = 1; b.end('victory'); });
await page.waitForTimeout(4200);
await page.screenshot({ path: `${out}/results_${lang}.png` });
await browser.close();
