// Destructible building test: pound a house with HE until it collapses, check that sight and
// shells now pass, and take before / damaged / after screenshots.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const [out = '/tmp'] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => (errors.push(e.message), console.log('[pageerror]', e.message)));
await page.goto(process.env.URL ?? 'http://localhost:5173/');
await page.waitForTimeout(700);
let ok = true;
const check = (n, c, i = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${i}`);
  if (!c) ok = false;
};
await page.evaluate(() => {
  const s = window.__pen.save();
  s.settings.map = 'valley';
  s.stats.battles = 5;
  s.lineup = ['is2'];
});
await page.evaluate(() => window.__pen.startBattle());
await page.waitForTimeout(1200);
const setup = await page.evaluate(async () => {
  const mapm = await import('/src/game/map.ts');
  const b = window.__pen.battle;
  const p = b.player;
  b.ais.clear();
  b.checkEnd = () => {};
  for (const t of b.tanks) if (t !== p) t.pos = { x: 5, y: 5 + t.id * 9 };
  // a village house; park 45 m away looking at it
  const bld = b.map.buildings.filter((x) => x.roof === 'gable').sort((x, y) => Math.hypot(x.cx - 222, x.cy - 222) - Math.hypot(y.cx - 222, y.cy - 222))[0];
  let pos = null;
  for (let a = 0; a < Math.PI * 2; a += 0.2) {
    const q = { x: bld.cx + Math.cos(a) * 45, y: bld.cy + Math.sin(a) * 45 };
    if (b.nav.free(q) && !mapm.losBlocked(b.map, q, { x: bld.cx + Math.cos(a) * 9, y: bld.cy + Math.sin(a) * 9 })) {
      pos = q;
      break;
    }
  }
  p.pos = pos;
  p.ang = Math.atan2(bld.cy - pos.y, bld.cx - pos.x);
  p.aimAngle = p.ang;
  p.turretRel = 0;
  p.speed = 0;
  p.vel = { x: 0, y: 0 };
  // a point straight behind the house
  const behind = { x: bld.cx + Math.cos(p.ang) * (Math.max(bld.w, bld.h) + 6), y: bld.cy + Math.sin(p.ang) * (Math.max(bld.w, bld.h) + 6) };
  window.__bld = bld;
  window.__behind = behind;
  b.time = 6;
  return { id: bld.id, hp: bld.maxHp, area: Math.round(bld.w * bld.h), blockedBefore: mapm.losBlocked(b.map, p.turretPos(), behind) };
});
console.log('house', JSON.stringify(setup));
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/bd_before.png` });
let shots = 0;
let state = 0;
for (let i = 0; i < 12 && state < 2; i++) {
  await page.evaluate(() => {
    const b = window.__pen.battle;
    const p = b.player;
    p.shellIdx = p.spec.gun.shells.findIndex((s) => s.type === 'HE');
    p.reloadLeft = 0;
    p.bloom = 0;
    p.wantFire = true;
  });
  shots++;
  await page.waitForTimeout(450);
  state = await page.evaluate(() => window.__bld.dmg);
  if (state === 1 && !(await page.evaluate(() => window.__shotDamaged))) {
    await page.evaluate(() => (window.__shotDamaged = 1));
    await page.screenshot({ path: `${out}/bd_damaged.png` });
  }
}
const after = await page.evaluate(async () => {
  const mapm = await import('/src/game/map.ts');
  const b = window.__pen.battle;
  const p = b.player;
  return { dmg: window.__bld.dmg, roof: window.__bld.roof, blockedAfter: mapm.losBlocked(b.map, p.turretPos(), window.__behind), occl: b.map.occluders.filter((o) => o.bid === window.__bld.id).length, shellBlocked: !!mapm.shellObstacleHit(b.map, p.turretPos(), window.__behind) };
});
check('house collapses under HE fire', after.dmg === 2 && after.roof === 'ruin', `${shots} shots ${JSON.stringify(after)}`);
check('sight and shells pass the ruin', setup.blockedBefore && !after.blockedAfter && after.occl === 0 && !after.shellBlocked);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/bd_after.png` });
await page.waitForTimeout(3500);
await page.screenshot({ path: `${out}/bd_after2.png` });
check('no page errors', errors.length === 0, errors.join(' | '));
console.log(ok ? 'ALL PASS' : 'SOME FAILED');
await browser.close();
process.exit(ok ? 0 : 1);
