import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const [out] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
console.error('goto'); await page.goto('http://localhost:5173/'); console.error('loaded');
await page.waitForTimeout(600);
await page.evaluate(() => { const s = window.__pen.save(); s.settings.map = 'valley'; s.stats.battles = 5; s.lineup = ['m4a2']; });
await page.evaluate(() => window.__pen.startBattle());
await page.waitForTimeout(1500);
console.error('battle up');
for (const [shell, yaw, aimx, name] of [[1, 70, -0.6, 'ap_side'], [0, 0, 0.6, 'aphe_front']]) {
  await page.evaluate(async ([shell, yaw, aimx]) => {
    const A = await import('/src/game/armor.ts');
    const b = window.__pen.battle; const p = b.player;
    const e = b.tanks.find(t => t.team !== p.team && t.spec.id !== 'puma');
    e.pos = { x: p.pos.x + 120, y: p.pos.y }; e.ang = Math.PI + yaw * Math.PI / 180;
    const c = Math.cos(e.ang), s = Math.sin(e.ang);
    const aim = { x: e.pos.x + aimx * c - 0.0 * s, y: e.pos.y + aimx * s };
    const m = p.pos; const dx = aim.x - m.x, dy = aim.y - m.y, l = Math.hypot(dx, dy); const dir = { x: dx / l, y: dy / l };
    for (let k = 0; k < 20; k++) {
      for (const mm of e.mods) mm.hp = mm.def.maxHp;
      const hit = A.intersectTank(e, m, { x: m.x + dir.x * 400, y: m.y + dir.y * 400 }, 0.9, 1, true);
      const r = A.resolveImpact(p, e, p.spec.gun.shells[shell], hit, 120, dir);
      if (r.outcome === 'pen' && r.damage > 0) { window.__pen.hud.handle({ type: 'hit', res: r, shooter: p, target: e }); break; }
    }
  }, [shell, yaw, aimx]);
  console.error('injected', name);
  await page.waitForTimeout(1300);
  const clip = await page.evaluate(() => { const W = innerWidth, H = innerHeight; const hw = Math.min(320, Math.max(230, W * 0.32)); return { x: W - hw - 14, y: 40, width: hw + 12, height: Math.min(200, Math.max(140, H * 0.44)) + 40 }; });
  await page.screenshot({ path: `${out}/hitcam_${name}.png`, clip });
}
await browser.close();
