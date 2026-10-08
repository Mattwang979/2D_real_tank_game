// Crew carrier test: hurt the crew, press CREW, watch the half-track arrive, park, swap crew;
// then a second call where the carrier gets shot on the way.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const [out = '/tmp'] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => (errors.push(e.message), console.log('[pageerror]', e.message)));
await page.goto(process.env.URL ?? 'http://localhost:5173/');
await page.waitForTimeout(700);
const cdp = await ctx.newCDPSession(page);
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y, id]) => ({ x, y, id, radiusX: 5, radiusY: 5, force: 1 })) });
const ev = (f, a) => page.evaluate(f, a);
let ok = true;
const check = (n, c, i = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${i}`);
  if (!c) ok = false;
};
await ev(() => {
  const s = window.__pen.save();
  s.settings.map = 'valley';
  s.stats.battles = 5;
  s.lineup = ['m4a2'];
});
await ev(() => window.__pen.startBattle());
await page.waitForTimeout(1200);
await ev(() => {
  const b = window.__pen.battle;
  b.time = 6;
  b.ais.clear();
  b.checkEnd = () => {};
  const p = b.player;
  // drive the player 70 m into the field, enemies far away
  p.pos = { x: p.pos.x + 70, y: p.pos.y };
  for (const t of b.tanks) if (t.team !== p.team) t.pos = { x: 420, y: 30 + t.id * 8 };
  // one crew member dead, another wounded
  const crew = p.mods.filter((m) => m.def.kind === 'crew');
  crew[1].hp = 0;
  crew[2].hp = crew[2].def.maxHp * 0.4;
});
await page.waitForTimeout(400);
const btn = await ev(() => window.__pen.hud.buttons.find((b) => b.id === 'crew'));
check('crew button present', !!btn);
await page.screenshot({ path: `${out}/cr_before.png` });
await touch('touchStart', [[btn.x, btn.y, 3]]);
await touch('touchEnd', []);
await page.waitForTimeout(300);
let st = await ev(() => {
  const b = window.__pen.battle;
  return b.carriers.map((c) => ({ state: c.state, d: Math.hypot(c.pos.x - b.player.pos.x, c.pos.y - b.player.pos.y) | 0 }));
});
check('carrier dispatched', st.length === 1 && st[0].state === 'drive', JSON.stringify(st));
let parked = false;
for (let i = 0; i < 60 && !parked; i++) {
  await page.waitForTimeout(250);
  parked = await ev(() => window.__pen.battle.carriers[0]?.state === 'park');
  if (i === 6) await page.screenshot({ path: `${out}/cr_drive.png` });
}
check('carrier parked next to the tank', parked);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/cr_park.png` });
await page.waitForTimeout(3000);
st = await ev(() => {
  const p = window.__pen.battle.player;
  return { crew: p.mods.filter((m) => m.def.kind === 'crew').map((m) => Math.round((m.hp / m.def.maxHp) * 100)), cd: Math.round(p.crewCd), state: window.__pen.battle.carriers[0]?.state };
});
check('crew replaced after 4 s', st.crew.every((h) => h === 100) && st.cd > 30 && st.state === 'leave', JSON.stringify(st));
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/cr_leave.png` });
// second call: an enemy shoots the carrier on its way in
await ev(() => {
  const b = window.__pen.battle;
  const p = b.player;
  p.crewCd = 0;
  p.mods.filter((m) => m.def.kind === 'crew')[1].hp = 0;
  b.carriers.length = 0;
  b.useCrew(p);
});
await page.waitForTimeout(1500);
await ev(() => {
  const b = window.__pen.battle;
  const c = b.carriers[0];
  const e = b.tanks.find((t) => t.team !== b.player.team);
  e.pos = { x: c.pos.x + 40, y: c.pos.y - 25 };
  e.aimAngle = Math.atan2(c.pos.y - e.pos.y, c.pos.x - e.pos.x);
  e.turretRel = e.aimAngle - e.ang;
  e.gunRel = 0;
  e.reloadLeft = 0;
  e.speed = 0;
  e.vel = { x: 0, y: 0 };
  e.throttle = 0;
  // fire straight at it (no dispersion)
  e.shotAngle = () => Math.atan2(c.pos.y + Math.sin(c.ang) * c.speed * 0.15 - e.pos.y, c.pos.x + Math.cos(c.ang) * c.speed * 0.15 - e.pos.x);
  e.wantFire = true;
  window.__killsBefore = e.kills;
  window.__rewards = b.rewards.length;
});
await page.waitForTimeout(1200);
st = await ev(() => {
  const b = window.__pen.battle;
  const e = b.tanks.find((t) => t.team !== b.player.team);
  return { state: b.carriers[0]?.state, cd: Math.round(b.player.crewCd), kills: e.kills - window.__killsBefore, tickets: b.tickets };
});
check('carrier destroyed by a hit, no score', st.state === 'dead' && st.cd > 15 && st.kills === 0 && st.tickets[0] === 800, JSON.stringify(st));
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/cr_dead.png` });
check('no page errors', errors.length === 0, errors.join(' | '));
console.log(ok ? 'ALL PASS' : 'SOME FAILED');
await browser.close();
process.exit(ok ? 0 : 1);
