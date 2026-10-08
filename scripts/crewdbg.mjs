import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://localhost:5173/');
await page.waitForTimeout(500);
const out = await page.evaluate(async () => {
  const A = await import('/src/game/armor.ts');
  const { Tank } = await import('/src/game/tank.ts');
  const { getVehicle } = await import('/src/data/vehicles.ts');
  const res = { turret: { n: 0, dead: 0, ko: 0, hist: [0,0,0,0,0,0] }, hull: { n: 0, dead: 0, ko: 0, hist: [0,0,0,0,0,0] } };
  const ex = [];
  for (let i = 0; i < 400; i++) {
    const s = new Tank(getVehicle('tiger1'), 0, { x: 0, y: 0 }, 0, 's');
    const t = new Tank(getVehicle('m4a2'), 1, { x: 500, y: 0 }, Math.PI, 't');
    const dir = { x: 1, y: (Math.random() - 0.5) * 0.002 };
    const hit = A.intersectTank(t, { x: 0, y: 0 }, { x: 2000, y: dir.y * 2000 }, Math.random(), 1, true);
    const r = A.resolveImpact(s, t, s.spec.gun.shells[0], hit, 500, dir);
    const dead = t.mods.filter(m => m.def.kind === 'crew' && m.hp <= 0).length;
    const k = hit.part === 'turret' ? 'turret' : 'hull';
    res[k].n++; res[k].dead += dead; res[k].hist[dead]++; if (t.knockedOut()) res[k].ko++;
    if (ex.length < 3 && k === 'turret') ex.push({ entry: [r.entry.x.toFixed(2), r.entry.y.toFixed(2)], blast: r.blast && [r.blast.c.x.toFixed(2), r.blast.c.y.toFixed(2), r.blast.r.toFixed(2)], crew: t.mods.filter(m => m.def.kind === 'crew').map(m => `${m.role}:${Math.round(m.hp)}`).join(' '), segs: r.segs.length, msgs: r.messages.join('; ') });
  }
  return { res, ex };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
