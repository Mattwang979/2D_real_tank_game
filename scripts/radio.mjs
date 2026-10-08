// Team radio: menu by touch, commands with pings, AI teammates obeying and answering, minimap pings.
// Needs `npm run dev`. Usage: node scripts/radio.mjs [outDir]
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
await page.evaluate(() => {
  const s = window.__pen.save();
  s.settings.weather = 'clear';
  s.settings.map = 'valley';
  s.stats.battles = 5;
});
await page.evaluate(() => window.__pen.startBattle());
await page.waitForFunction(() => window.__pen.battle && window.__pen.battle.player);
await page.waitForTimeout(5000); // past the opening banner
await page.evaluate(() => {
  window.__pen.hud.autoInput = (p) => {
    p.throttle = 0;
    p.steer = 0;
  };
});
const btn = (id) => page.evaluate((i) => window.__pen.hud.buttons.find((b) => b.id === i) ?? null, id);
const tapBtn = async (id) => {
  const b = await btn(id);
  if (!b) return false;
  const x = b.r !== undefined ? b.x : b.x + b.w / 2;
  const y = b.r !== undefined ? b.y : b.y + b.h / 2;
  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(120);
  return true;
};

check('radio button present', !!(await btn('radio')));
await tapBtn('radio');
const open = await page.evaluate(() => ({ open: window.__pen.hud.radioOpen, items: window.__pen.hud.buttons.filter((b) => b.id.startsWith('radio:')).length }));
check('radio menu opens with 8 commands', open.open && open.items === 8, JSON.stringify(open));
await page.screenshot({ path: `${out}/radio_menu.png` });

// ATTACK A
const roles0 = await page.evaluate(() => [...window.__pen.battle.ais.values()].filter((a) => a.tank.team === window.__pen.battle.playerTeam).map((a) => a.role));
await tapBtn('radio:0');
await page.waitForTimeout(150);
const atk = await page.evaluate(() => {
  const h = window.__pen.hud;
  const b = window.__pen.battle;
  return {
    open: h.radioOpen,
    feed: h.feed.filter((f) => f.radio).map((f) => f.text),
    pings: h.pings.map((p) => ({ kind: p.kind, d: Math.hypot(p.x - b.map.capture.x, p.y - b.map.capture.y) })),
    roles: [...b.ais.values()].filter((a) => a.tank.team === b.playerTeam).map((a) => a.role),
    said: window.__pen.voice?.last,
  };
});
check('attack: menu closes, line in the radio log', !atk.open && atk.feed.some((t) => t.includes('Attack point A')), JSON.stringify(atk.feed));
check('attack: ping on the point', atk.pings.some((p) => p.kind === 'attack' && p.d < 1), JSON.stringify(atk.pings));
check('attack: AI teammates switch to capping', atk.roles.filter((r) => r === 'capper').length > roles0.filter((r) => r === 'capper').length || atk.roles.every((r) => r === 'capper'), `${roles0} → ${atk.roles}`);
await page.waitForTimeout(2200);
const reply = await page.evaluate(() => window.__pen.hud.feed.filter((f) => f.radio).map((f) => f.text));
check('attack: an AI teammate answers', reply.some((t) => t.includes('Affirmative')), JSON.stringify(reply));
await page.screenshot({ path: `${out}/radio_attack.png` });

// HELP ME: the two nearest AI come over
await page.waitForTimeout(1500);
await tapBtn('radio');
await tapBtn('radio:2');
const help = await page.evaluate(() => {
  const b = window.__pen.battle;
  const p = b.player;
  const ord = [...b.ais.values()].filter((a) => a.order).map((a) => ({ id: a.tank.id, kind: a.order.kind, d: Math.hypot(a.order.pos.x - p.pos.x, a.order.pos.y - p.pos.y), dist: Math.hypot(a.tank.pos.x - p.pos.x, a.tank.pos.y - p.pos.y) }));
  return ord;
});
check('help: two AI teammates ordered to us', help.length === 2 && help.every((o) => o.kind === 'goto' && o.d < 1), JSON.stringify(help));
await page.waitForTimeout(6000);
const helpAfter = await page.evaluate((ids) => {
  const b = window.__pen.battle;
  const p = b.player;
  return ids.map((id) => {
    const t = b.tanks.find((x) => x.id === id);
    return Math.hypot(t.pos.x - p.pos.x, t.pos.y - p.pos.y);
  });
}, help.map((o) => o.id));
check('help: they close in', helpAfter.some((d, i) => d < help[i].dist - 3 || d < 20), `${help.map((o) => o.dist.toFixed(0))} → ${helpAfter.map((d) => d.toFixed(0))}`);

// minimap ping
const mm = await page.evaluate(() => {
  const h = window.__pen.hud;
  const size = Math.min(128, Math.max(96, h.r.H * 0.3));
  return { x: h.safe.l + 10, y: h.safe.t + 10, size, S: window.__pen.battle.map.size };
});
await page.waitForTimeout(1600);
await page.touchscreen.tap(mm.x + mm.size * 0.7, mm.y + mm.size * 0.3);
await page.waitForTimeout(200);
const ping = await page.evaluate(() => window.__pen.hud.pings.filter((p) => p.kind === 'ping').map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })));
const want = { x: 0.7 * mm.S, y: 0.3 * mm.S };
check('minimap tap pings that spot', ping.some((p) => Math.hypot(p.x - want.x, p.y - want.y) < 8), JSON.stringify(ping));
const noStick = await page.evaluate(() => !window.__pen.hud.move);
check('minimap tap does not grab the drive stick', noStick);
await page.screenshot({ path: `${out}/radio_ping.png` });

// spam guard
await page.waitForTimeout(1600);
const n0 = await page.evaluate(() => window.__pen.hud.feed.filter((f) => f.radio && f.text.includes('Thanks')).length);
await page.evaluate(() => {
  window.__pen.hud.sendRadio(7);
  window.__pen.hud.sendRadio(7);
  window.__pen.hud.sendRadio(7);
});
await page.waitForTimeout(150);
const n1 = await page.evaluate(() => window.__pen.hud.feed.filter((f) => f.radio && f.text.includes('Thanks')).length);
check('radio spam is throttled', n1 - n0 === 1, `${n0} → ${n1}`);
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(ok ? 'ALL PASS' : 'SOME FAILED');
await browser.close();
process.exit(ok ? 0 : 1);
