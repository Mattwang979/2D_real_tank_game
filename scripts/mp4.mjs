// 4-player soak test (1 host + 3 clients) against a local PeerServer: everyone drives and shoots
// for a while; checks for page errors, desync and bandwidth.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const [out = '/tmp', secs = '45'] = process.argv.slice(2);
const BASE = (process.env.URL ?? 'http://localhost:5173/') + '?peerhost=127.0.0.1&peerport=9000&peerpath=/';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
});
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(5), ...a);
let errors = 0;
const mk = async (name) => {
  const ctx = await browser.newContext({ viewport: { width: 740, height: 360 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => (errors++, log(`[${name} pageerror]`, e.message)));
  await page.goto(BASE);
  await page.waitForTimeout(600);
  await page.evaluate((n) => {
    const s = window.__pen.save();
    s.playerName = n;
    s.stats.battles = 5;
    s.settings.quality = 'low';
  }, name);
  return page;
};
const waitFor = async (page, fn, arg, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await page.evaluate(fn, arg)) return true;
    await page.waitForTimeout(200);
  }
  return false;
};
const host = await mk('Host');
await host.evaluate(() => window.__pen.openLobby());
await host.getByText('CREATE ROOM', { exact: true }).click();
await waitFor(host, () => !!window.__pen.lobby.host);
const code = await host.evaluate(() => window.__pen.lobby.host.code);
const clients = [];
for (const n of ['Ann', 'Bob', 'Cid']) {
  const c = await mk(n);
  await c.evaluate((k) => window.__pen.openLobby(k), code);
  clients.push(c);
}
const joined = await waitFor(host, () => window.__pen.lobby.host.players.length === 4, null, 30000);
log('joined', joined, await host.evaluate(() => window.__pen.lobby.host.players.map((p) => `${p.name}:${p.team}`).join(' ')));
await host.getByText('START BATTLE', { exact: true }).click();
for (const c of clients) await waitFor(c, () => !!window.__pen.battle?.player, null, 20000);
log('all in battle');
const bot = () => {
  const b = window.__pen.battle;
  const hud = window.__pen.hud;
  let t = 0;
  hud.autoInput = (p) => {
    t += 1 / 60;
    const c = b.map.capture;
    const want = Math.atan2(c.y - p.pos.y, c.x - p.pos.x);
    let d = want - p.ang;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    p.throttle = Math.hypot(c.x - p.pos.x, c.y - p.pos.y) > 40 ? 1 : 0.2;
    p.steer = Math.max(-1, Math.min(1, d * 2));
    p.handbrake = Math.sin(t * 0.7) > 0.97;
    let best = null;
    let bd = 1e9;
    for (const e of b.tanks) {
      if (!e.alive || e.team === p.team || !b.isSpotted(p.team, e)) continue;
      const dd = Math.hypot(e.pos.x - p.pos.x, e.pos.y - p.pos.y);
      if (dd < bd) {
        bd = dd;
        best = e;
      }
    }
    if (best) {
      const aim = Math.atan2(best.pos.y - p.pos.y, best.pos.x - p.pos.x);
      p.aimAngle = aim;
      if (p.isReloaded() && !p.fireReq) {
        hud.controls.fire(aim);
        p.fireReq = { until: b.time + 3 };
      }
    }
    if (b.state === 'dead') {
      const av = b.availableLineup();
      if (av.length && b.time - b.deadAt > 3) hud.controls.respawn(av[0].id);
    }
  };
  setInterval(() => {
    if (b.state === 'dead') {
      const av = b.availableLineup();
      if (av.length && b.time - b.deadAt > 3) hud.controls.respawn(av[0].id);
    }
  }, 500);
};
await host.evaluate(bot);
for (const c of clients) await c.evaluate(bot);
await host.evaluate(() => {
  window.__bytes = 0;
  for (const c of window.__pen.lobby.host.conns.values()) {
    const s0 = c.send.bind(c);
    c.send = (m) => {
      window.__bytes += JSON.stringify(m).length;
      return s0(m);
    };
  }
});
const N = Number(secs);
for (let i = 0; i < N; i += 5) {
  await host.waitForTimeout(5000);
  const hs = await host.evaluate(() => {
    const b = window.__pen.battle;
    if (!b) return null;
    return { t: b.time.toFixed(0), tk: b.tickets.map((x) => x | 0), alive: b.tanks.filter((t) => t.alive).length, tanks: b.tanks.length, humans: b.slots.map((s) => `${s.name}:${s.stats.shots}/${s.stats.hits + s.stats.crits}${s.dead ? '†' : ''}`).join(' ') };
  });
  const cs = [];
  for (const c of clients) {
    cs.push(
      await c.evaluate(() => {
        const b = window.__pen.battle;
        if (!b) return 'none';
        const me = b.player;
        return `${b.tanks.length}t ${window.__pen.hud?.netInfo ?? ''} ${me ? (me.alive ? 'alive' : 'dead') : '-'}`;
      }),
    );
  }
  log(JSON.stringify(hs), '|', cs.join(' | '));
  if (!hs) break;
}
// position agreement between host and each client for every live tank
for (const [i, c] of clients.entries()) {
  const hp = await host.evaluate(() => Object.fromEntries(window.__pen.battle?.tanks.filter((t) => t.alive).map((t) => [t.id, [t.pos.x, t.pos.y]]) ?? []));
  const cp = await c.evaluate(() => Object.fromEntries(window.__pen.battle?.tanks.filter((t) => t.alive).map((t) => [t.id, [t.pos.x, t.pos.y]]) ?? []));
  let maxErr = 0;
  let n = 0;
  for (const [id, p] of Object.entries(hp)) {
    const q = cp[id];
    if (!q) continue;
    n++;
    maxErr = Math.max(maxErr, Math.hypot(p[0] - q[0], p[1] - q[1]));
  }
  log(`client ${i}: ${n} tanks compared, max position error ${maxErr.toFixed(2)} m`);
}
const bytes = await host.evaluate(() => window.__bytes);
log(`host upload ≈ ${(bytes / 1024 / N).toFixed(1)} KB/s total for 3 clients`);
await host.screenshot({ path: `${out}/mp4_host.png` });
await clients[0].screenshot({ path: `${out}/mp4_c0.png` });
log(errors ? `ERRORS: ${errors}` : 'no page errors');
await browser.close();
