// AI difficulty check: the same three AI tanks (M4A2, Pz IV H, T-34) shoot at the unkillable
// player tank from the same spots at 60 / 120 / 200 m (and at 120 m while it drives in circles),
// once per difficulty. Prints hit rate and shots per run, and checks easy < normal < hard.
// Needs `npm run dev`. Usage: node scripts/aiaccuracy.mjs
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const URL = process.env.URL ?? 'http://localhost:5173/';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let ok = true;
const check = (name, cond, info = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${info}`);
  if (!cond) ok = false;
};
await page.goto(URL);
await page.waitForTimeout(500);
const results = {};
for (const level of ['easy', 'normal', 'hard']) {
  await page.evaluate((lv) => {
    const s = window.__pen.save();
    s.settings.map = 'valley';
    s.settings.weather = 'clear';
    s.settings.aiLevel = lv;
    s.settings.killcam = false;
    s.stats.battles = 5;
    s.lineup = ['m4a2'];
  }, level);
  await page.evaluate(() => window.__pen.startBattle());
  await page.waitForFunction(() => window.__pen.battle && window.__pen.battle.player);
  await page.waitForTimeout(300);
  results[level] = await page.evaluate(async () => {
    const b = window.__pen.battle;
    const M = await import('/src/game/map.ts');
    const { Tank } = await import('/src/game/tank.ts');
    const { AIController } = await import('/src/game/ai.ts');
    const { getVehicle } = await import('/src/data/vehicles.ts');
    const p = b.player;
    // the target never dies and never gets crippled; nobody else takes part
    const kill = b.kill.bind(b);
    b.kill = (t, ...a) => (t === p ? undefined : kill(t, ...a));
    b.isSpotted = () => true;
    for (const t of b.tanks) if (t !== p) t.pos = { x: -500, y: -500 };
    b.ais.clear();
    window.__pen.hud.autoInput = () => {};
    const S = b.map.size;
    // the same spots for every difficulty (seeded)
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const spots = {};
    for (const d of [60, 120, 200]) {
      spots[d] = [];
      for (let k = 0; k < 400 && spots[d].length < 4; k++) {
        const t0 = { x: S * (0.25 + rnd() * 0.5), y: S * (0.25 + rnd() * 0.5) };
        const a = rnd() * Math.PI * 2;
        const q = { x: t0.x + Math.cos(a) * d, y: t0.y + Math.sin(a) * d };
        if (q.x < 15 || q.y < 15 || q.x > S - 15 || q.y > S - 15) continue;
        if (M.shellObstacleHit(b.map, q, t0) || M.bermCover(b.map, q, t0) || M.losBlocked(b.map, q, t0)) continue;
        spots[d].push({ t: t0, s: q, ta: rnd() * Math.PI * 2 });
      }
    }
    const out = {};
    for (const [d, moving] of [
      [60, false],
      [120, false],
      [200, false],
      [120, true],
    ]) {
      let hits = 0;
      let shots = 0;
      let runs = 0;
      for (const vid of ['m4a2', 'pz4h', 't34_41']) {
        for (const sp of spots[d]) {
          const sh = new Tank(getVehicle(vid), p.team === 0 ? 1 : 0, sp.s, Math.atan2(sp.t.y - sp.s.y, sp.t.x - sp.s.x) + 0.4, 'Shooter');
          b.equip(sh);
          b.tanks.push(sh);
          const ai = new AIController(sh, b, 'support');
          const upd = ai.update.bind(ai);
          ai.update = (dt, now) => {
            upd(dt, now);
            sh.throttle = 0;
          };
          b.ais.set(sh.id, ai);
          p.pos = { ...sp.t };
          p.vel = { x: 0, y: 0 };
          p.speed = 0;
          p.ang = sp.ta;
          // keep the battle going: clock, tickets and the point reset every run
          b.time = 30;
          b.tickets = [800, 800];
          b.capture.owner = -1;
          b.capture.progress = 0;
          runs++;
          for (let i = 0; i < 30 * 40; i++) {
            for (const m of p.mods) m.hp = m.def.maxHp;
            p.burning = 0;
            p.alive = true;
            p.throttle = moving ? 0.6 : 0;
            p.steer = moving ? 0.3 : 0;
            b.update(1 / 30);
            for (const e of b.events) if (e.type === 'hit' && e.shooter === sh && e.target === p && e.res.outcome !== 'wreck') hits++;
            b.events.length = 0;
          }
          shots += sh.spec.gun.shells.reduce((a, s, i) => a + (s.count - sh.ammo[i]), 0);
          b.ais.delete(sh.id);
          b.tanks.splice(b.tanks.indexOf(sh), 1);
          b.projectiles = [];
        }
      }
      out[`${d}${moving ? 'm' : ''}`] = { hits, shots, runs, rate: shots ? +(hits / shots).toFixed(2) : 0, perRun: +(shots / Math.max(1, runs)).toFixed(1) };
    }
    return out;
  });
  console.log(level.padEnd(6), Object.entries(results[level]).map(([k, v]) => `${k}: ${Math.round(v.rate * 100)}% (${v.hits}/${v.shots}, ${v.perRun}/run)`).join('  '));
  await page.evaluate(() => window.__pen.battle.end('defeat'));
  await page.waitForTimeout(3500);
  await page.evaluate(() => window.__pen.show('hangar'));
}
const hr = (lv, k) => results[lv][k].rate;
const all = (lv) => {
  const v = Object.values(results[lv]);
  return +(v.reduce((a, r) => a + r.hits, 0) / Math.max(1, v.reduce((a, r) => a + r.shots, 0))).toFixed(2);
};
// ~60 shots per cell: easy and normal both miss most shots at 200 m, so only the pooled rate has to be
// strictly ordered; per range, normal must stay below hard and easy may not beat normal by much.
check('overall hit rate easy < normal < hard', all('easy') < all('normal') && all('normal') < all('hard'), `${all('easy')} / ${all('normal')} / ${all('hard')}`);
for (const k of ['60', '120', '200', '120m']) check(`at ${k}: normal < hard, easy ≲ normal`, hr('normal', k) < hr('hard', k) && hr('easy', k) <= hr('normal', k) + 0.1, `${hr('easy', k)} / ${hr('normal', k)} / ${hr('hard', k)}`);
check('normal clearly weaker than hard at 120 m', hr('normal', '120') <= hr('hard', '120') - 0.15, `${hr('normal', '120')} vs ${hr('hard', '120')}`);
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(ok ? 'ALL PASS' : 'SOME FAILED');
await browser.close();
process.exit(ok ? 0 : 1);
