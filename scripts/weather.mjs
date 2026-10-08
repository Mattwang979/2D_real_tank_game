// Weather & night battles: vision ranges per weather, rain mud, night flares lighting up enemies.
// Needs `npm run dev` (http://localhost:5173/). Usage: node scripts/weather.mjs [outDir]
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const [out = '/tmp'] = process.argv.slice(2);
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
await page.waitForTimeout(600);

async function start(weather, map = 'valley') {
  await page.evaluate(
    ([w, m]) => {
      const s = window.__pen.save();
      s.settings.weather = w;
      s.settings.map = m;
      s.stats.battles = 5;
      window.__pen.show('hangar');
    },
    [weather, map],
  );
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__pen.startBattle());
  await page.waitForFunction(() => window.__pen.battle && window.__pen.battle.player);
  await page.waitForTimeout(300);
}
async function leave() {
  await page.evaluate(() => {
    const b = window.__pen.battle;
    if (b) b.end('defeat');
  });
  await page.waitForTimeout(3200);
}

for (const [w, mul] of [
  ['clear', 1],
  ['rain', 0.78],
  ['fog', 0.52],
]) {
  await start(w, w === 'rain' ? 'outpost' : 'valley');
  const info = await page.evaluate(() => {
    const b = window.__pen.battle;
    return { id: b.weather.id, range: b.player.visionCone().range, near: b.player.visionCone().near };
  });
  check(`${w}: battle weather`, info.id === w, JSON.stringify(info));
  check(`${w}: vision range scaled`, Math.abs(info.range - 230 * mul) < 0.5, `${info.range.toFixed(1)} vs ${(230 * mul).toFixed(1)}`);
  // drive a little so rain splashes / fog wisps animate
  await page.evaluate(() => {
    window.__pen.hud.autoInput = (p) => {
      p.throttle = 0.6;
      p.steer = 0.15;
    };
  });
  await page.waitForTimeout(4600);
  if (w === 'rain') {
    // off-road the tracks sink into the mud
    const mud = await page.evaluate(async () => {
      const { onRoad } = await import('/src/game/map.ts');
      const b = window.__pen.battle;
      const p = b.player;
      let spot = null;
      for (let i = 0; i < 400 && !spot; i++) {
        const q = { x: 40 + Math.random() * (b.map.size - 80), y: 40 + Math.random() * (b.map.size - 80) };
        if (!onRoad(b.map, q) && b.nav.free(q)) spot = q;
      }
      p.pos.x = spot.x;
      p.pos.y = spot.y;
      await new Promise((r) => setTimeout(r, 300));
      return { mul: p.terrainMul, road: onRoad(b.map, p.pos) };
    });
    check('rain: mud slows tanks off-road', mud.road || Math.abs(mud.mul - 0.84) < 0.01 || Math.abs(mud.mul - 0.42) < 0.01, JSON.stringify(mud));
  }
  await page.screenshot({ path: `${out}/wx_${w}.png` });
  await page.evaluate(() => (window.__pen.hud.autoInput = null));
  await leave();
}

// ---------------------------------------------------------------- night + flares
await start('night', 'valley');
const n0 = await page.evaluate(() => {
  const b = window.__pen.battle;
  const p = b.player;
  return { id: b.weather.id, range: p.visionCone().range, flares: p.flareCharges, btn: window.__pen.hud.buttons.some((x) => x.id === 'flare') };
});
check('night: battle weather', n0.id === 'night', JSON.stringify(n0));
check('night: short sight', Math.abs(n0.range - 230 * 0.46) < 0.5);
check('night: two flares and a FLARE button', n0.flares === 2 && n0.btn);
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/wx_night.png` });

// set up: freeze the AI, park one enemy in the open 85 m away, everyone else far off
const setup = await page.evaluate(async () => {
  const { losBlocked } = await import('/src/game/map.ts');
  const b = window.__pen.battle;
  b.ais.clear();
  const p = b.player;
  for (const t of b.tanks) {
    t.throttle = 0;
    t.steer = 0;
    t.speed = 0;
    t.vel = { x: 0, y: 0 };
  }
  // an open spot for us
  const S = b.map.size;
  let me = null;
  let ang = 0;
  for (let i = 0; i < 600 && !me; i++) {
    const q = { x: 110 + Math.random() * (S - 220), y: 110 + Math.random() * (S - 220) };
    if (!b.nav.free(q)) continue;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const e = { x: q.x + Math.cos(a) * 85, y: q.y + Math.sin(a) * 85 };
      if (b.nav.free(e) && !losBlocked(b.map, q, e)) {
        me = q;
        ang = a;
        break;
      }
    }
  }
  p.pos = { ...me };
  const enemy = b.tanks.find((t) => t.alive && t.team !== p.team);
  enemy.pos = { x: me.x + Math.cos(ang) * 85, y: me.y + Math.sin(ang) * 85 };
  // gun pointing away from the enemy, everybody else out of the way
  p.ang = ang + Math.PI;
  p.turretRel = 0;
  p.aimAngle = ang + Math.PI;
  for (const t of b.tanks) {
    if (t === p || t === enemy) continue;
    const sp = b.map.spawns[t.team][t.id % 5];
    t.pos = { x: sp.x, y: sp.y };
  }
  window.__pen.hud.autoInput = (q) => {
    q.throttle = 0;
    q.steer = 0;
  };
  return { ang, enemy: enemy.id };
});
await page.waitForTimeout(700);
const before = await page.evaluate((id) => window.__pen.battle.isSpotted(window.__pen.battle.playerTeam, window.__pen.battle.tanks.find((t) => t.id === id)), setup.enemy);
check('night: enemy 85 m away unseen in the dark', !before);
await page.evaluate((a) => window.__pen.hud.controls.flare(a), setup.ang);
const fl = await page.evaluate(() => ({ n: window.__pen.battle.flares.length, left: window.__pen.battle.player.flareCharges }));
check('night: flare launched', fl.n === 1 && fl.left === 1, JSON.stringify(fl));
await page.waitForTimeout(2000);
const after = await page.evaluate((id) => {
  const b = window.__pen.battle;
  const e = b.tanks.find((t) => t.id === id);
  return { lit: b.lit.has(id), spotted: b.isSpotted(b.playerTeam, e) };
}, setup.enemy);
check('night: flare lights up and reveals the enemy', after.lit && after.spotted, JSON.stringify(after));
await page.evaluate((a) => {
  const r = window.__pen.renderer;
  r.zoomIdx = 0;
}, setup.ang);
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/wx_night_flare.png` });
// AI fires flares on its own at night
const aiFlare = await page.evaluate(async () => {
  window.__pen.battle.end('defeat');
  return true;
});
await page.waitForTimeout(3200);
await page.evaluate(() => (window.__pen.hud ? (window.__pen.hud.autoInput = null) : 0));
await start('night', 'outpost');
await page.evaluate(() => {
  window.__pen.hud.autoInput = (p) => {
    p.throttle = 0;
    p.steer = 0;
  };
});
let aiFlares = 0;
for (let i = 0; i < 40 && !aiFlares; i++) {
  await page.waitForTimeout(1000);
  aiFlares = await page.evaluate(() => window.__pen.battle.flares.filter((f) => true).length + (window.__pen.battle.tanks.filter((t) => !t.isPlayer && t.flareCharges < 2).length > 0 ? 1 : 0));
}
check('night: AI fires flares', aiFlares > 0, `after ~${aiFlares ? '' : '40 '}s`);
await page.screenshot({ path: `${out}/wx_night_ai.png` });
void aiFlare;
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(ok ? 'ALL PASS' : 'SOME FAILED');
await browser.close();
process.exit(ok ? 0 : 1);
