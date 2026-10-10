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
await page.waitForTimeout(300);
st = await ev(() => {
  const b = window.__pen.battle;
  const r = b.recons[0];
  return r && { kind: r.kind, tin: r.tin, t: r.t, revealing: r.t >= r.tin - 1.4 };
});
check('recon plane on its way in (not revealing yet)', !!st && !st.revealing && st.tin > 1.5 && st.tin < 6, JSON.stringify(st));
check('plane type follows the nation (Pz IV → Storch)', st?.kind === 1);
await page.waitForFunction(() => {
  const r = window.__pen.battle.recons[0];
  return r && r.t >= r.tin - 1.4 + 0.5;
}, null, { timeout: 8000 });
st = await ev(() => {
  const b = window.__pen.battle;
  const p = b.player;
  const alive = b.tanks.filter((t) => t.alive && t.team !== p.team);
  return { recons: b.recons.length, spotted: alive.filter((t) => b.isSpotted(p.team, t)).length, alive: alive.length, pill: true };
});
check('recon reveals every enemy once the camera is on', st.recons === 1 && st.spotted === st.alive, JSON.stringify(st));
await page.screenshot({ path: `${out}/sp_recon.png` });
// the plane stays for the reveal and then leaves
const left = await ev(async () => {
  const b = window.__pen.battle;
  const r = b.recons[0];
  const { reconTotal } = await import('/src/game/support.ts');
  return reconTotal(r) - r.t;
});
await page.waitForTimeout(left * 1000 + 700);
st = await ev(() => ({ recons: window.__pen.battle.recons.length }));
check('plane gone after its flight', st.recons === 0, JSON.stringify({ ...st, waited: left.toFixed(1) }));
// third kill → artillery
st = await ev(() => {
  const b = window.__pen.battle;
  const p = b.player;
  const e = b.tanks.find((t) => t.team !== p.team && t.alive);
  b.kill(e, p, 'crew', null);
  return { arty: b.supportOf(p).arty, streak: p.streak };
});
check('three kills give artillery', st.arty === 1 && st.streak === 3, JSON.stringify(st));
// park two enemies together, call artillery on them from the big map
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
  return { world: tp };
});
await page.waitForTimeout(300);
const ab = await ev(() => window.__pen.hud.buttons.find((b) => b.id === 'arty'));
await touch('touchStart', [[ab.x, ab.y, 4]]);
await touch('touchEnd', []);
await page.waitForTimeout(250);
check('arty button opens the target map', await ev(() => window.__pen.hud.targeting && !!window.__pen.hud.artyMap.g));
const g = await ev(() => window.__pen.hud.artyMap.g);
// FIRE does nothing before a target is placed
await touch('touchStart', [[g.fire.x + g.fire.w / 2, g.fire.y + g.fire.h / 2, 5]]);
await touch('touchEnd', []);
await page.waitForTimeout(150);
check('no strike without a target', await ev(() => window.__pen.battle.artys.length === 0 && window.__pen.hud.targeting));
// tap a few metres off, then fine-tune with the magnifier onto the pair
const off = { x: target.world.x - 12, y: target.world.y + 8 };
await touch('touchStart', [[g.mx + off.x * g.k, g.my + off.y * g.k, 6]]);
await touch('touchEnd', []);
await page.waitForTimeout(150);
let tg = await ev(() => ({ ...window.__pen.hud.artyMap.target }));
check('tap on the map places the target', Math.hypot(tg.x - off.x, tg.y - off.y) < 2, JSON.stringify(tg));
const dx = (tg.x - (target.world.x + 3)) * g.lz;
const dy = (tg.y - (target.world.y + 2)) * g.lz;
await touch('touchStart', [[g.lx, g.ly, 7]]);
for (let i = 1; i <= 10; i++) {
  await touch('touchMove', [[g.lx + (dx * i) / 10, g.ly + (dy * i) / 10, 7]]);
  await page.waitForTimeout(16);
}
await touch('touchEnd', []);
await page.waitForTimeout(200);
tg = await ev(() => ({ ...window.__pen.hud.artyMap.target }));
check('magnifier drag fine-tunes the target', Math.hypot(tg.x - (target.world.x + 3), tg.y - (target.world.y + 2)) < 1.5, JSON.stringify(tg));
const zone = await ev(() => window.__pen.hud.artyMap.zone());
check('map counts the enemies in the zone', zone && zone.enemies >= 2 && !zone.me, JSON.stringify(zone));
await page.screenshot({ path: `${out}/sp_target.png` });
const health = () =>
  ev(() => {
    const b = window.__pen.battle;
    return window.__artyTargets.map((id) => {
      const t = b.tanks.find((x) => x.id === id);
      return { alive: t.alive, crew: t.mods.filter((m) => m.def.kind === 'crew' && m.hp > 0).length, hp: Math.round(t.mods.reduce((a, m) => a + m.hp, 0)) };
    });
  });
const before = await health();
await touch('touchStart', [[g.fire.x + g.fire.w / 2, g.fire.y + g.fire.h / 2, 8]]);
await touch('touchEnd', []);
await page.waitForTimeout(300);
st = await ev(() => ({ artys: window.__pen.battle.artys.map((a) => [a.x, a.y]), targeting: window.__pen.hud.targeting, stock: window.__pen.battle.supportOf(window.__pen.battle.player).arty }));
check('artillery called on the chosen spot', st.artys.length === 1 && !st.targeting && st.stock === 0 && Math.hypot(st.artys[0][0] - tg.x, st.artys[0][1] - tg.y) < 0.5, JSON.stringify(st));
await page.waitForTimeout(1600);
await page.screenshot({ path: `${out}/sp_warning.png` });
await page.waitForTimeout(3200);
await page.screenshot({ path: `${out}/sp_impacts.png` });
await page.waitForTimeout(1500);
const after = await health();
st = await ev(() => ({ streak: window.__pen.battle.player.streak }));
// 8 shells scatter over the zone, so a tank can come through untouched now and then — but rarely both
check('artillery hurt the targets', after.some((t, i) => !t.alive || t.crew < before[i].crew || t.hp < before[i].hp), JSON.stringify({ before, after }));
check('artillery kills do not feed the streak', st.streak === 3, `streak ${st.streak}`);
check('no page errors', errors.length === 0, errors.join(' | '));
console.log(ok ? 'ALL PASS' : 'SOME FAILED');
await browser.close();
process.exit(ok ? 0 : 1);
