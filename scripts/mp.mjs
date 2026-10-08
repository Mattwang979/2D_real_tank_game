// Multiplayer end-to-end test with a local PeerServer (node peersrv on 127.0.0.1:9000):
// host creates a room, client joins by code, battle starts, inputs/fire/respawn flow, results, rematch lobby.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const [out = '/tmp'] = process.argv.slice(2);
const BASE = (process.env.URL ?? 'http://localhost:5173/') + '?peerhost=127.0.0.1&peerport=9000&peerpath=/';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--use-fake-ui-for-media-stream'],
});
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(5), ...a);
let ok = true;
const check = (name, cond, info = '') => {
  log(`${cond ? 'PASS' : 'FAIL'} ${name} ${info}`);
  if (!cond) ok = false;
};
const mk = async (name) => {
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log(`[${name} pageerror]`, e.message));
  page.on('console', (m) => m.type() === 'error' && log(`[${name} console]`, m.text().slice(0, 200)));
  await page.goto(BASE);
  await page.waitForTimeout(700);
  await page.evaluate((n) => {
    const s = window.__pen.save();
    s.playerName = n;
    s.stats.battles = 5; // no tutorial
  }, name);
  return page;
};
const waitFor = async (page, fn, arg, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await page.evaluate(fn, arg)) return true;
    await page.waitForTimeout(150);
  }
  return false;
};

const host = await mk('Hosty');
const client = await mk('Cli');
await host.evaluate(() => window.__pen.openLobby());
await host.getByText('CREATE ROOM', { exact: true }).click();
check('room created', await waitFor(host, () => !!window.__pen.lobby.host));
const code = await host.evaluate(() => window.__pen.lobby.host.code);
log('room code', code);
await host.screenshot({ path: `${out}/mp_host_lobby1.png` });

// client joins through the menu
await client.evaluate(() => window.__pen.openLobby());
await client.locator('input.lb-codein').fill(code.toLowerCase());
await client.getByText('JOIN', { exact: true }).click();
check('client joined', await waitFor(client, () => !!window.__pen.lobby.client && window.__pen.lobby.client.players.length === 2, null, 25000));
check('host sees 2 players', await waitFor(host, () => window.__pen.lobby.host.players.length === 2));
await client.screenshot({ path: `${out}/mp_client_lobby.png` });
// client switches team, host picks the map
await client.getByText('Switch team', { exact: true }).click();
await waitFor(host, () => window.__pen.lobby.host.players[1].team === 0);
await host.evaluate(() => window.__pen.lobby.host.setMap('valley'));
await host.waitForTimeout(300);
const lob = await client.evaluate(() => ({ map: window.__pen.lobby.client.mapId, players: window.__pen.lobby.client.players.map((p) => [p.name, p.team]) }));
check('lobby sync (team switch + map)', lob.map === 'valley' && lob.players[1][1] === 0, JSON.stringify(lob));
await host.screenshot({ path: `${out}/mp_host_lobby2.png` });

// start
await host.getByText('START BATTLE', { exact: true }).click();
check('host in battle', await waitFor(host, () => !!window.__pen.battle && window.__pen.battle.mode === 'host'));
check('client in battle', await waitFor(client, () => !!window.__pen.battle && window.__pen.battle.mode === 'replica' && !!window.__pen.battle.player, null, 20000));
await client.waitForTimeout(1500);
const sync = await client.evaluate(() => {
  const b = window.__pen.battle;
  return { tanks: b.tanks.length, alive: b.tanks.filter((t) => t.alive).length, me: b.player?.spec.id, team: b.playerTeam, time: b.time.toFixed(1), net: window.__pen.hud.netInfo };
});
const hostView = await host.evaluate(() => {
  const b = window.__pen.battle;
  const s = b.slots.find((x) => x.key !== 'host');
  return { tanks: b.tanks.length, time: b.time.toFixed(1), remote: s.tank && { id: s.tank.id, x: s.tank.pos.x, y: s.tank.pos.y, team: s.team } };
});
log('client view', JSON.stringify(sync), 'host view', JSON.stringify(hostView));
check('client replica has all tanks', sync.tanks === hostView.tanks && sync.tanks >= 10, `${sync.tanks} vs ${hostView.tanks}`);
// both humans on team 0
check('client on the same team as host', sync.team === 0);

// client drives forward: host should see the remote tank move
await client.evaluate(() => {
  window.__pen.hud.autoInput = (p) => {
    p.throttle = 1;
    p.steer = 0.2;
  };
});
await client.waitForTimeout(2500);
const moved = await host.evaluate((h0) => {
  const b = window.__pen.battle;
  const t = b.slots.find((x) => x.key !== 'host').tank;
  return { d: Math.hypot(t.pos.x - h0.x, t.pos.y - h0.y), speed: t.speed };
}, hostView.remote);
check('host sees the client drive', moved.d > 5, JSON.stringify(moved));
const drift = await Promise.all([
  client.evaluate(() => {
    const p = window.__pen.battle.player;
    return { x: p.pos.x, y: p.pos.y };
  }),
  host.evaluate(() => {
    const t = window.__pen.battle.slots.find((x) => x.key !== 'host').tank;
    return { x: t.pos.x, y: t.pos.y };
  }),
]);
const err = Math.hypot(drift[0].x - drift[1].x, drift[0].y - drift[1].y);
check('client prediction close to host', err < 4, `err ${err.toFixed(2)} m`);
await client.evaluate(() => {
  window.__pen.hud.autoInput = (p) => {
    p.throttle = 0;
    p.steer = 0;
  };
});
// measure host upload
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
// client fires through the fire stick API
await client.waitForTimeout(1000);
const shots0 = await host.evaluate(() => window.__pen.battle.slots.find((x) => x.key !== 'host').stats.shots);
await client.evaluate(() => {
  const b = window.__pen.battle;
  const p = b.player;
  window.__pen.hud.controls.fire(p.gunWorldAng + 0.3);
});
check('client shot reaches host', await waitFor(host, (s0) => window.__pen.battle.slots.find((x) => x.key !== 'host').stats.shots > s0, shots0, 8000));
check('client sees its own shot', await waitFor(client, () => window.__pen.battle.projectiles.some((p) => p.shooter.isPlayer) || window.__pen.battle.player.recoil > 0, null, 3000));
await client.waitForTimeout(200);
await client.screenshot({ path: `${out}/mp_client_battle.png` });
await host.screenshot({ path: `${out}/mp_host_battle.png` });
await host.waitForTimeout(2000);
const bytes = await host.evaluate(() => window.__bytes);
log(`host upload ≈ ${(bytes / 1024 / 3.4).toFixed(1)} KB/s per client`);

// smoke from the client
await client.evaluate(() => window.__pen.hud.controls.smoke(0));
check('client smoke creates clouds on both', (await waitFor(host, () => window.__pen.battle.map.smokes.length >= 3, null, 4000)) && (await waitFor(client, () => window.__pen.battle.map.smokes.length >= 3, null, 4000)));

// kill the client's tank on the host → death screen → respawn
await host.evaluate(() => {
  const b = window.__pen.battle;
  const t = b.slots.find((x) => x.key !== 'host').tank;
  const enemy = b.tanks.find((e) => e.team !== t.team && e.alive);
  b.kill(t, enemy, 'cookoff', null);
});
check('client sees its death', await waitFor(client, () => window.__pen.battle.state === 'dead', null, 5000));
await client.waitForTimeout(3000);
await client.screenshot({ path: `${out}/mp_client_dead.png` });
const spawnId = await client.evaluate(() => window.__pen.battle.availableLineup()[0]?.id);
await client.evaluate((id) => window.__pen.hud.controls.respawn(id), spawnId);
check('client respawned', await waitFor(client, () => window.__pen.battle.state === 'playing' && window.__pen.battle.player.alive, null, 6000), spawnId);

// end the battle: enemy tickets to zero
await host.evaluate(() => {
  window.__pen.battle.tickets[1] = 0;
});
check('host results', await waitFor(host, () => document.querySelector('#results.active') !== null, null, 8000));
check('client results', await waitFor(client, () => document.querySelector('#results.active') !== null, null, 8000));
const res = await client.evaluate(() => document.querySelector('.res-title')?.textContent + ' | ' + document.querySelector('.res-total')?.textContent);
log('client result', res);
await client.screenshot({ path: `${out}/mp_client_results.png` });
// back to lobby (rematch)
await host.getByText('Continue', { exact: true }).click();
await client.getByText('Continue', { exact: true }).click();
check('host back in lobby', await waitFor(host, () => document.querySelector('#lobby.active') !== null && window.__pen.lobby.host.phase === 'lobby'));
check('client back in lobby', await waitFor(client, () => document.querySelector('#lobby.active') !== null && window.__pen.lobby.client?.phase === 'lobby'));
await client.screenshot({ path: `${out}/mp_client_lobby2.png` });
// client leaves
await client.getByText('Leave', { exact: false }).first().click();
check('host sees client leave', await waitFor(host, () => window.__pen.lobby.host.players.length === 1, null, 6000));
console.log(ok ? 'ALL PASS' : 'SOME FAILED');
await browser.close();
process.exit(ok ? 0 : 1);
