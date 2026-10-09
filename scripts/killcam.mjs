// Kill replay + vibration test: an enemy is put broadside of the player and shoots until the player
// is knocked out; the replay must start, follow the fatal shell, end by itself and hand over to the
// death screen; a second death is skipped with the SKIP button. Vibration patterns are logged.
// Needs `npm run dev`. Usage: node scripts/killcam.mjs [outDir]
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const [out = '/tmp'] = process.argv.slice(2);
const URL = process.env.URL ?? 'http://localhost:5173/';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => (errors.push(e.message), console.log('[pageerror]', e.message)));
let ok = true;
const check = (name, cond, info = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${info}`);
  if (!cond) ok = false;
};
const ev = (f, a) => page.evaluate(f, a);
await page.addInitScript((lang) => {
  // count vibration calls (desktop Chromium has no motor)
  window.__vib = [];
  navigator.vibrate = (p) => (window.__vib.push(p), true);
  if (lang && !localStorage.getItem('penetration.save.v1')) localStorage.setItem('penetration.save.v1', JSON.stringify({ settings: { lang } }));
}, process.env.KC_LANG ?? '');
await page.goto(URL);
await page.waitForTimeout(600);
await ev((wx) => {
  const s = window.__pen.save();
  s.settings.weather = wx;
  s.settings.map = 'valley';
  s.settings.killcam = true;
  s.settings.haptics = true;
  s.stats.battles = 5;
  s.lineup = ['m4a2', 'pz4h'];
  window.__pen.haptics.log = [];
}, process.env.WX ?? 'clear');
await ev(() => window.__pen.startBattle());
await page.waitForFunction(() => window.__pen.battle && window.__pen.battle.player);
// note every hit the player takes (alive afterwards or not)
await ev(() => {
  const h = window.__pen.hud;
  const orig = h.handle.bind(h);
  window.__hits = [];
  h.handle = (e) => {
    if (e.type === 'hit' && e.target.isPlayer) window.__hits.push(e.target.alive);
    orig(e);
  };
});
await page.waitForTimeout(4800);

/** Park an enemy broadside of the player at `d` metres and let it shoot until the player dies. */
async function killPlayer(d) {
  const enemyId = await ev(async (d) => {
    const b = window.__pen.battle;
    const M = await import('/src/game/map.ts');
    b.ais.clear();
    const p = b.player;
    const e = b.tanks.find((t) => t.alive && t.team !== p.team);
    // a spot `d` metres away, preferably broadside, with a clear shot (no house, rock, wall or bank)
    let best = null;
    for (let i = 0; i < 24 && !best; i++) {
      const side = p.ang + Math.PI / 2 + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * (Math.PI / 12);
      const q = { x: p.pos.x + Math.cos(side) * d, y: p.pos.y + Math.sin(side) * d };
      if (q.x < 15 || q.y < 15 || q.x > b.map.size - 15 || q.y > b.map.size - 15) continue;
      if (M.shellObstacleHit(b.map, q, p.pos) || M.bermCover(b.map, q, p.pos) || M.losBlocked(b.map, q, p.pos)) continue;
      best = q;
    }
    best = best ?? { x: p.pos.x + Math.cos(p.ang + Math.PI / 2) * d, y: p.pos.y + Math.sin(p.ang + Math.PI / 2) * d };
    e.pos.x = Math.min(b.map.size - 15, Math.max(15, best.x));
    e.pos.y = Math.min(b.map.size - 15, Math.max(15, best.y));
    e.vel.x = e.vel.y = 0;
    e.speed = 0;
    e.throttle = 0;
    e.steer = 0;
    // facing the player a little off-line: the gun has to swing onto the target first
    e.ang = Math.atan2(p.pos.y - e.pos.y, p.pos.x - e.pos.x) + 0.12;
    e.turretRel = 0;
    e.gunRel = 0;
    e.reloadLeft = 1.5;
    // the player sits still
    window.__pen.hud.autoInput = (t) => {
      t.throttle = 0;
      t.steer = 0;
    };
    return e.id;
  }, d);
  const t0 = Date.now();
  let shots = 0;
  while (Date.now() - t0 < 40000) {
    const st = await ev((id) => {
      const b = window.__pen.battle;
      const p = b.player;
      const e = b.tanks.find((t) => t.id === id);
      if (!p.alive || b.state !== 'playing') return 'dead';
      if (!e.alive) return 'enemy-dead';
      const tp = e.turretPos();
      e.aimAngle = Math.atan2(p.pos.y - tp.y, p.pos.x - tp.x);
      if (e.reloadLeft > 1.2) e.reloadLeft = 1.2; // quicker loader
      if (e.isReloaded() && e.aimError() < 0.01) {
        e.wantFire = true;
        return 'fired';
      }
      return 'alive';
    }, enemyId);
    if (st === 'fired') shots++;
    else if (st !== 'alive') return { st, enemyId, shots };
    await page.waitForTimeout(100);
  }
  return { st: 'timeout', enemyId, shots, info: await ev((id) => { const b = window.__pen.battle; const e = b.tanks.find((t) => t.id === id); const p = b.player; return { e: e.spec.id, d: Math.hypot(e.pos.x - p.pos.x, e.pos.y - p.pos.y), err: e.aimError(), crew: p.crewAlive().length, hits: window.__hits.length }; }, enemyId) };
}

// ------------------------------------------------------------------ 1: watch the whole replay
// the player fires once first (vibration on the shot) — out toward the map edge, clear of teammates
await ev(() => {
  const b = window.__pen.battle;
  b.ais.clear();
  const p = b.player;
  const out = p.pos.x < b.map.size / 2 ? Math.PI : 0;
  p.aimAngle = out;
  p.turretRel = out - p.ang;
  p.reloadLeft = 0;
  b.requestFire(p, out);
});
await page.waitForTimeout(400);
const k1 = await killPlayer(Number(process.env.KC_DIST ?? 70));
check('player knocked out by the parked enemy', k1.st === 'dead', k1.st);
await page.waitForTimeout(300);
const pend = await ev(() => ({ pending: window.__pen.hud.killcam?.pending, active: window.__pen.hud.killcam?.active }));
check('replay queued, not yet playing', pend.pending && !pend.active, JSON.stringify(pend));
await page.screenshot({ path: `${out}/kc_wreck.png` });
console.log('  at the wreck', JSON.stringify(await ev(() => {
  const b = window.__pen.battle;
  const p = b.player;
  const near = b.fx.parts.filter((q) => Math.hypot(q.x - p.pos.x, q.y - p.pos.y) < 25);
  const kinds = {};
  for (const q of near) kinds[q.kind] = (kinds[q.kind] ?? 0) + 1;
  return { smokes: b.map.smokes.map((c) => [Math.round(c.x - p.pos.x), Math.round(c.y - p.pos.y), c.team]), kinds, cook: p.cookedOff };
})));
await page.waitForFunction(() => window.__pen.hud.killcam?.active, null, { timeout: 4000 }).catch(() => {});
const info = await ev((id) => {
  const kc = window.__pen.hud.killcam;
  return { active: kc.active, killer: kc.killer?.id, want: id, fatal: kc.fatal, duration: +kc.duration.toFixed(2), window: [+(kc.t0 - kc.deathT).toFixed(2), +(kc.t1 - kc.deathT).toFixed(2)], slow: +kc.slowK.toFixed(2), skip: window.__pen.hud.buttons.some((b) => b.id === 'skip') };
}, k1.enemyId);
check('replay starts after the kill', info.active, JSON.stringify(info));
check('replay shows the right killer', info.killer === info.want);
check('fatal shell found', !!info.fatal);
check('replay length sensible (4–10 s)', info.duration >= 4 && info.duration <= 10, `${info.duration}s`);
check('SKIP button shown', info.skip);
const seen = new Set();
const shots = [];
const tStart = Date.now();
let ended = false;
while (Date.now() - tStart < 14000) {
  const s = await ev(() => {
    const kc = window.__pen.hud.killcam;
    return { active: kc.active, mode: kc.mode, rt: kc.rt - kc.deathT, slow: kc.slowmo, after: kc.afterKill };
  });
  if (!s.active) {
    ended = true;
    break;
  }
  const key = s.after ? 'hit' : s.mode;
  if (!seen.has(key)) {
    seen.add(key);
    await page.screenshot({ path: `${out}/kc_${key}.png` });
    shots.push(`${key}@${s.rt.toFixed(2)}${s.slow ? ' slow' : ''}`);
  }
  await page.waitForTimeout(60);
}
const took = (Date.now() - tStart) / 1000;
check('camera went lead → shell → hit', seen.has('lead') && seen.has('shot') && seen.has('hit'), shots.join(', '));
check('replay ends by itself', ended, `${took.toFixed(1)}s`);
await page.waitForTimeout(500);
const after = await ev(() => {
  const h = window.__pen.hud;
  return { state: window.__pen.battle.state, deathT: h.deathInfo?.t, spawn: h.buttons.filter((b) => b.id.startsWith('spawn:')).length };
});
check('death screen after the replay', after.state === 'dead' && after.spawn > 0 && after.deathT < 1.5, JSON.stringify(after));
await page.screenshot({ path: `${out}/kc_death.png` });

// ------------------------------------------------------------------ 2: skip it
await page.waitForTimeout(2200);
await ev(() => {
  const b = window.__pen.battle;
  const id = b.availableLineup()[0].id;
  window.__pen.hud.controls.respawn(id);
  window.__pen.hud.deathInfo = null;
});
await page.waitForTimeout(1500);
const k2 = await killPlayer(55);
check('second knock-out', k2.st === 'dead', `${k2.st} after ${k2.shots} shots ${k2.info ? JSON.stringify(k2.info) : ''}`);
await page.waitForFunction(() => window.__pen.hud.killcam?.active, null, { timeout: 4000 }).catch(() => {});
await page.waitForTimeout(700);
const skipBtn = await ev(() => window.__pen.hud.buttons.find((b) => b.id === 'skip') ?? null);
check('SKIP button during the second replay', !!skipBtn);
if (skipBtn) await page.touchscreen.tap(skipBtn.x + skipBtn.w / 2, skipBtn.y + skipBtn.h / 2);
await page.waitForTimeout(250);
const sk = await ev(() => ({ active: window.__pen.hud.killcam.active, state: window.__pen.battle.state, hold: window.__pen.hud.killcam.rec.hold }));
check('SKIP ends the replay at once', !sk.active && sk.state === 'dead' && !sk.hold, JSON.stringify(sk));
await page.screenshot({ path: `${out}/kc_skipped.png` });

// ------------------------------------------------------------------ vibration
const vib = await ev(() => ({ log: window.__pen.haptics.log.map((x) => x.why), calls: window.__vib.length, survived: window.__hits.filter((a) => a).length }));
check('vibrated on our own shot', vib.log.includes('fire'), vib.log.join(','));
if (vib.survived) check('vibrated when hit', vib.log.includes('pen') || vib.log.includes('glance'), `${vib.survived} hits survived`);
else console.log('  (every hit was a knock-out: no plain hit to feel)');
check('long buzz when knocked out', vib.log.filter((w) => w === 'dead').length >= 2);
check('navigator.vibrate called', vib.calls >= vib.log.length - 1, `${vib.calls} calls`);
const rec = await ev(() => ({ frames: window.__pen.hud.killcam.rec.frames.length, parts: window.__pen.hud.killcam.rec.parts.length }));
check('recording stays bounded', rec.frames < 700 && rec.parts < 20000, JSON.stringify(rec));
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(ok ? 'ALL PASS' : 'SOME FAILED');
await browser.close();
process.exit(ok ? 0 : 1);
