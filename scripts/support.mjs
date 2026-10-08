// Killstreak support test: streak awards, recon reveal, artillery strike via targeting UI.
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
  s.settings.map = 'outpost';
  s.stats.battles = 5;
  s.lineup = ['pz4h'];
});
await ev(() => window.__pen.startBattle());
await page.waitForTimeout(1200);
// streak: three kills credited to the player
let st = await ev(() => {
  const b = window.__pen.battle;
  b.time = 6;
  b.checkEnd = () => {};
  const p = b.player;
  const enemies = b.tanks.filter((t) => t.team !== p.team);
  b.kill(enemies[0], p, 'crew', null);
  const a = { ...b.supportOf(p) };
  b.kill(enemies[1], p, 'crew', null);
  const c = { ...b.supportOf(p) };
  return { streak: p.streak, after1: a, after2: c };
});
check('two kills give recon', st.after2.recon === 1 && st.after1.recon === 0, JSON.stringify(st));
await page.waitForTimeout(300);
// recon button → all enemies spotted
const rb = await ev(() => window.__pen.hud.buttons.find((b) => b.id === 'recon'));
check('recon button shown', !!rb);
await page.screenshot({ path: `${out}/sp_buttons.png` });
await touch('touchStart', [[rb.x, rb.y, 3]]);
await touch('touchEnd', []);
await page.waitForTimeout(500);
st = await ev(() => {
  const b = window.__pen.battle;
  const p = b.player;
  const alive = b.tanks.filter((t) => t.alive && t.team !== p.team);
  return { recons: b.recons.length, spotted: alive.filter((t) => b.isSpotted(p.team, t)).length, alive: alive.length };
});
check('recon reveals every enemy', st.recons === 1 && st.spotted === st.alive, JSON.stringify(st));
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/sp_recon.png` });
// third kill → artillery
st = await ev(() => {
  const b = window.__pen.battle;
  const p = b.player;
  const e = b.tanks.find((t) => t.team !== p.team && t.alive);
  b.kill(e, p, 'crew', null);
  return { arty: b.supportOf(p).arty, streak: p.streak };
});
check('three kills give artillery', st.arty === 1 && st.streak === 3, JSON.stringify(st));
// park two enemies together in view, call artillery on them by tapping the battlefield
const target = await ev(() => {
  const b = window.__pen.battle;
  const p = b.player;
  b.ais.clear();
  const es = b.tanks.filter((t) => t.team !== p.team && t.alive).slice(0, 2);
  const tp = { x: p.pos.x + Math.cos(p.ang) * 45, y: p.pos.y + Math.sin(p.ang) * 45 };
  es.forEach((e, i) => {
    e.pos = { x: tp.x + i * 6, y: tp.y + i * 4 };
    e.speed = 0;
    e.vel = { x: 0, y: 0 };
    e.throttle = 0;
  });
  window.__artyTargets = es.map((e) => e.id);
  const r = window.__pen.renderer;
  r.cam = { x: (p.pos.x + tp.x) / 2, y: (p.pos.y + tp.y) / 2 };
  return { world: tp, screen: r.toScreen(tp) };
});
await page.waitForTimeout(300);
const ab = await ev(() => window.__pen.hud.buttons.find((b) => b.id === 'arty'));
await touch('touchStart', [[ab.x, ab.y, 4]]);
await touch('touchEnd', []);
await page.waitForTimeout(200);
check('arty button enters targeting', await ev(() => window.__pen.hud.targeting));
const sp = await ev((w) => window.__pen.renderer.toScreen(w), target.world);
await touch('touchStart', [[sp.x, sp.y, 5]]);
await page.waitForTimeout(150);
await page.screenshot({ path: `${out}/sp_target.png` });
await touch('touchEnd', []);
await page.waitForTimeout(400);
st = await ev(() => ({ artys: window.__pen.battle.artys.length, targeting: window.__pen.hud.targeting }));
check('artillery called', st.artys === 1 && !st.targeting, JSON.stringify(st));
await page.waitForTimeout(1600);
await page.screenshot({ path: `${out}/sp_warning.png` });
await page.waitForTimeout(3200);
await page.screenshot({ path: `${out}/sp_impacts.png` });
await page.waitForTimeout(1500);
st = await ev(() => {
  const b = window.__pen.battle;
  const p = b.player;
  const ts = window.__artyTargets.map((id) => b.tanks.find((t) => t.id === id));
  return { streak: p.streak, targets: ts.map((t) => ({ alive: t.alive, crew: t.mods.filter((m) => m.def.kind === 'crew' && m.hp > 0).length, track: t.moduleOk('track') })), craters: true };
});
check('artillery hurt the targets', st.targets.some((t) => !t.alive || t.crew < 4 || !t.track), JSON.stringify(st));
check('artillery kills do not feed the streak', st.streak === 3, `streak ${st.streak}`);
check('no page errors', errors.length === 0, errors.join(' | '));
console.log(ok ? 'ALL PASS' : 'SOME FAILED');
await browser.close();
process.exit(ok ? 0 : 1);
