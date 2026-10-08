// Controls v2 test via CDP touch events: fire joystick (aim / fire / cancel / tap), aim persistence,
// smoke stick, handbrake, boost, repair, zoom buttons, pinch and precision sight.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const [out = '/tmp'] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => (errors.push(e.message), console.log('[pageerror]', e.message)));
await page.goto(process.env.URL ?? 'http://localhost:5173/');
await page.waitForTimeout(800);
const cdp = await ctx.newCDPSession(page);
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y, id]) => ({ x, y, id, radiusX: 5, radiusY: 5, force: 1 })) });
const ev = (f, a) => page.evaluate(f, a);
const wait = (ms) => page.waitForTimeout(ms);
let ok = true;
const check = (name, cond, info = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${info}`);
  if (!cond) ok = false;
};

await touch('touchStart', [[420, 200, 1]]);
await touch('touchEnd', []);
await wait(600);
await ev(() => {
  window.__pen.save().settings.map = 'valley';
});
await ev(() => window.__pen.startBattle());
await wait(1500);
// keep enemies away & make the test deterministic
await ev(() => {
  const b = window.__pen.battle;
  for (const t of b.tanks) if (t !== b.player) { t.alive = false; t.pos.x = -500; }
  b.ais.clear();
  b.respawnQueue.length = 0;
  b.reinforcements = [0, 0];
  b.tickets = [800, 800];
  b.checkEnd = () => {};
});
const fc = await ev(() => window.__pen.hud.fireC);
console.log('fire button', JSON.stringify(fc));

// 1) drag the fire stick up-left and hold: aim follows the stick, turret swings, nothing fires
await ev(() => (window.__pen.battle.player.reloadLeft = 0));
const shots0 = await ev(() => window.__pen.battle.stats.shots);
await touch('touchStart', [[fc.x, fc.y, 5]]);
for (let i = 1; i <= 10; i++) {
  await touch('touchMove', [[fc.x - i * 8, fc.y - i * 8, 5]]);
  await wait(20);
}
await wait(400);
let st = await ev(() => {
  const p = window.__pen.battle.player;
  return { aim: p.aimAngle, gun: p.gunWorldAng, shots: window.__pen.battle.stats.shots, stick: !!window.__pen.hud.fireStick };
});
check('fire stick held aims up-left', Math.abs(st.aim - -2.356) < 0.08 && st.stick, JSON.stringify(st));
check('holding does not fire', st.shots === shots0);
await page.screenshot({ path: `${out}/c2_aiming.png` });
// 2) release → queued shot fires once the turret is on target
await touch('touchEnd', []);
let fired = false;
for (let i = 0; i < 60 && !fired; i++) {
  await wait(100);
  fired = (await ev(() => window.__pen.battle.stats.shots)) > shots0;
}
st = await ev(() => {
  const p = window.__pen.battle.player;
  return { aim: p.aimAngle, gun: p.gunWorldAng, err: p.aimError() };
});
check('release fires at the aim', fired, JSON.stringify(st));
// 3) aim persists while the hull turns
const aimBefore = st.aim;
await touch('touchStart', [[160, 300, 1]]);
for (let i = 1; i <= 8; i++) {
  await touch('touchMove', [[160 + i * 9, 300, 1]]);
  await wait(30);
}
await wait(1500);
st = await ev(() => {
  const p = window.__pen.battle.player;
  return { aim: p.aimAngle, gun: p.gunWorldAng, ang: p.ang, speed: p.speed };
});
const wrap = (a) => Math.abs(Math.atan2(Math.sin(a), Math.cos(a)));
check('aim stays put while driving/turning', wrap(st.aim - aimBefore) < 1e-6 && wrap(st.gun - aimBefore) < 0.05, JSON.stringify(st));
// 4) handbrake while driving: hard stop
await ev(() => {
  const p = window.__pen.battle.player;
  p.speed = p.maxSpeed();
  p.vel = { x: Math.cos(p.ang) * p.speed, y: Math.sin(p.ang) * p.speed };
});
const brake = await ev(() => window.__pen.hud.buttons.find((b) => b.id === 'brake'));
await touch('touchStart', [[300, 300, 1], [brake.x, brake.y, 6]]);
await wait(1100);
st = await ev(() => {
  const p = window.__pen.battle.player;
  return { hb: p.handbrake, speed: p.speed, v: Math.hypot(p.vel.x, p.vel.y) };
});
check('handbrake held stops the tank', st.hb && st.v < 2, JSON.stringify(st));
await touch('touchEnd', []);
await wait(100);
check('handbrake released', !(await ev(() => window.__pen.battle.player.handbrake)));
await wait(200);
// 5) cancel: drag out then back into the centre → no shot
await ev(() => (window.__pen.battle.player.reloadLeft = 0));
const shots1 = await ev(() => window.__pen.battle.stats.shots);
await touch('touchStart', [[fc.x, fc.y, 7]]);
for (let i = 1; i <= 8; i++) {
  await touch('touchMove', [[fc.x - i * 10, fc.y, 7]]);
  await wait(20);
}
for (let i = 7; i >= 0; i--) {
  await touch('touchMove', [[fc.x - i * 10, fc.y + 1, 7]]);
  await wait(20);
}
await page.screenshot({ path: `${out}/c2_cancel.png` });
await touch('touchEnd', []);
await wait(2500);
check('back to centre cancels', (await ev(() => window.__pen.battle.stats.shots)) === shots1);
// 6) tap fires
await ev(() => (window.__pen.battle.player.reloadLeft = 0));
await touch('touchStart', [[fc.x + 3, fc.y - 2, 8]]);
await wait(80);
await touch('touchEnd', []);
fired = false;
for (let i = 0; i < 40 && !fired; i++) {
  await wait(100);
  fired = (await ev(() => window.__pen.battle.stats.shots)) > shots1;
}
check('tap fires', fired);
// 7) smoke stick: drag left and release
const sm = await ev(() => window.__pen.hud.buttons.find((b) => b.id === 'smoke'));
const ch0 = await ev(() => window.__pen.battle.player.smokeCharges);
await touch('touchStart', [[sm.x, sm.y, 9]]);
for (let i = 1; i <= 8; i++) {
  await touch('touchMove', [[sm.x - i * 9, sm.y + i * 2, 9]]);
  await wait(20);
}
await page.screenshot({ path: `${out}/c2_smokeaim.png` });
await touch('touchEnd', []);
await wait(1600);
st = await ev(() => {
  const b = window.__pen.battle;
  const p = b.player;
  const s = b.map.smokes.map((c) => Math.atan2(c.y - p.pos.y, c.x - p.pos.x));
  return { ch: p.smokeCharges, clouds: b.map.smokes.length, dirs: s };
});
check('smoke thrown to the left', st.ch === ch0 - 1 && st.clouds === 3 && st.dirs.every((a) => Math.abs(Math.abs(a) - Math.PI) < 0.6), JSON.stringify(st));
await wait(1200);
await page.screenshot({ path: `${out}/c2_smoke.png` });
// 8) boost
const bo = await ev(() => window.__pen.hud.buttons.find((b) => b.id === 'boost'));
await touch('touchStart', [[bo.x, bo.y, 10]]);
await touch('touchEnd', []);
await wait(100);
st = await ev(() => ({ t: window.__pen.battle.player.boostT, cd: window.__pen.battle.player.boostCd }));
check('boost starts', st.t > 3 && st.cd > 19, JSON.stringify(st));
// 9) repair a broken track
await ev(() => {
  const p = window.__pen.battle.player;
  for (const m of p.mods) if (m.def.kind === 'track') m.hp = 0;
});
const rp = await ev(() => window.__pen.hud.buttons.find((b) => b.id === 'repair'));
await page.screenshot({ path: `${out}/c2_needrepair.png` });
await touch('touchStart', [[rp.x, rp.y, 11]]);
await touch('touchEnd', []);
await wait(200);
st = await ev(() => window.__pen.battle.player.repairT);
check('repair starts', st > 5, String(st));
await wait(6500);
st = await ev(() => {
  const p = window.__pen.battle.player;
  return { canMove: p.canMove(), cd: p.repairCd };
});
check('repair restores the track', st.canMove && st.cd > 30, JSON.stringify(st));
// 10) zoom buttons + precision sight
const zin = await ev(() => window.__pen.hud.buttons.find((b) => b.id === 'zin'));
await touch('touchStart', [[zin.x, zin.y, 12]]);
await touch('touchEnd', []);
await touch('touchStart', [[zin.x, zin.y, 12]]);
await touch('touchEnd', []);
await wait(800);
check('zoom in to sniper level', (await ev(() => window.__pen.renderer.zoomIdx)) === 3);
// touch the battlefield: gun lays onto the touched point
const target = await ev(() => {
  const r = window.__pen.renderer;
  const w = r.toWorldPt({ x: 560, y: 120 });
  const tp = window.__pen.battle.player.turretPos();
  return Math.atan2(w.y - tp.y, w.x - tp.x);
});
await touch('touchStart', [[560, 120, 13]]);
await wait(300);
st = await ev(() => ({ aim: window.__pen.battle.player.aimAngle, lock: !!window.__pen.renderer.camLock }));
check('sight: aim at touched point', Math.abs(st.aim - target) < 0.02 && st.lock, `${JSON.stringify(st)} want ${target.toFixed(3)}`);
await page.screenshot({ path: `${out}/c2_sight.png` });
await touch('touchEnd', []);
await wait(100);
check('sight released unlocks camera', !(await ev(() => window.__pen.renderer.camLock)));
// pinch out → zoom out two steps
await touch('touchStart', [[520, 200, 14], [700, 200, 15]]);
for (let i = 1; i <= 8; i++) {
  await touch('touchMove', [[520 + i * 9, 200, 14], [700 - i * 9, 200, 15]]);
  await wait(20);
}
await touch('touchEnd', []);
await wait(500);
check('pinch zooms out', (await ev(() => window.__pen.renderer.zoomIdx)) < 3, String(await ev(() => window.__pen.renderer.zoomIdx)));
await page.screenshot({ path: `${out}/c2_end.png` });
check('no page errors', errors.length === 0, errors.join(' | '));
console.log(ok ? 'ALL PASS' : 'SOME FAILED');
await browser.close();
process.exit(ok ? 0 : 1);
