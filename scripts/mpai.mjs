// Multiplayer AI options: the host turns AI tanks off (players only — needs a player on each team),
// then back on at a chosen difficulty. Local PeerServer on 127.0.0.1:9000 and `npm run dev` needed.
// Usage: node scripts/mpai.mjs [outDir]
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const [out = '/tmp'] = process.argv.slice(2);
const BASE = (process.env.URL ?? 'http://localhost:5173/') + '?peerhost=127.0.0.1&peerport=9000&peerpath=/';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
});
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(5), ...a);
let ok = true;
const errors = [];
const check = (name, cond, info = '') => {
  log(`${cond ? 'PASS' : 'FAIL'} ${name} ${info}`);
  if (!cond) ok = false;
};
const mk = async (name) => {
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => (errors.push(e.message), log(`[${name} pageerror]`, e.message)));
  await page.goto(BASE);
  await page.waitForTimeout(700);
  await page.evaluate((n) => {
    const s = window.__pen.save();
    s.playerName = n;
    s.stats.battles = 5;
    s.settings.killcam = false;
    s.settings.mpFillAI = true;
    s.settings.aiLevel = 'normal';
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
await client.evaluate(() => window.__pen.openLobby());
await client.locator('input.lb-codein').fill(code);
await client.getByText('JOIN', { exact: true }).click();
check('client joined', await waitFor(client, () => window.__pen.lobby.client?.players.length === 2, null, 25000));

// AI off from the room screen
await host.locator('.lb-aiseg button', { hasText: 'Off' }).click();
check('host turned AI off', await host.evaluate(() => window.__pen.lobby.host.fillAI === false && window.__pen.save().settings.mpFillAI === false));
check('client sees AI off', await waitFor(client, () => window.__pen.lobby.client.fillAI === false));
check('client shows "Players only"', await waitFor(client, () => document.querySelector('.lb-bottom')?.textContent?.includes('Players only')));
// both on one team: can't start
await client.getByText('Switch team', { exact: true }).click();
await waitFor(host, () => window.__pen.lobby.host.players.every((p) => p.team === 0));
check('empty team flagged', await host.evaluate(() => document.querySelector('.lb-team.b')?.textContent?.includes('Needs at least one player')));
await host.screenshot({ path: `${out}/mpai_lobby_off.png` });
await host.getByText('START BATTLE', { exact: true }).click();
await host.waitForTimeout(400);
check('start refused with an empty team', await host.evaluate(() => window.__pen.lobby.host.phase === 'lobby' && !window.__pen.battle && [...document.querySelectorAll('.toast')].some((e) => e.textContent.includes('each team'))));
await client.getByText('Switch team', { exact: true }).click();
await waitFor(host, () => window.__pen.lobby.host.players[1]?.team === 1);
await host.getByText('START BATTLE', { exact: true }).click();
check('host in battle', await waitFor(host, () => !!window.__pen.battle));
check('client in battle', await waitFor(client, () => !!window.__pen.battle?.player, null, 20000));
await client.waitForTimeout(1500);
const offH = await host.evaluate(() => ({ tanks: window.__pen.battle.tanks.length, ais: window.__pen.battle.ais.size, fill: window.__pen.battle.fillAI, rf: window.__pen.battle.reinforcements }));
const offC = await client.evaluate(() => ({ tanks: window.__pen.battle.tanks.length, fill: window.__pen.battle.fillAI }));
check('players only: two tanks, no AI', offH.tanks === 2 && offH.ais === 0 && !offH.fill && offH.rf[0] === 0, JSON.stringify(offH));
check('client battle has no AI either', offC.tanks === 2 && offC.fill === false, JSON.stringify(offC));
await client.screenshot({ path: `${out}/mpai_battle_off.png` });

// back to the room, AI on at hard
await host.evaluate(() => {
  window.__pen.battle.tickets[1] = 0;
});
check('results on both', (await waitFor(host, () => document.querySelector('#results.active') !== null, null, 9000)) && (await waitFor(client, () => document.querySelector('#results.active') !== null, null, 9000)));
await host.getByText('Continue', { exact: true }).click();
await client.getByText('Continue', { exact: true }).click();
check('back in the room', (await waitFor(host, () => window.__pen.lobby.host.phase === 'lobby' && document.querySelector('#lobby.active') !== null)) && (await waitFor(client, () => window.__pen.lobby.client?.phase === 'lobby')));
await host.locator('.lb-aiseg button', { hasText: 'On' }).click();
await host.waitForTimeout(200);
await host.evaluate(() => window.__pen.lobby.host.setAILevel('hard'));
check('client sees AI on at hard', await waitFor(client, () => window.__pen.lobby.client.fillAI && window.__pen.lobby.client.aiLevel === 'hard'));
await host.screenshot({ path: `${out}/mpai_lobby_on.png` });
await client.screenshot({ path: `${out}/mpai_lobby_client.png` });
await host.getByText('START BATTLE', { exact: true }).click();
check('second battle on host', await waitFor(host, () => !!window.__pen.battle && window.__pen.battle.fillAI));
check('second battle on client', await waitFor(client, () => !!window.__pen.battle?.player && window.__pen.battle.fillAI, null, 20000));
const onH = await host.evaluate(() => ({ tanks: window.__pen.battle.tanks.length, levels: [...new Set([...window.__pen.battle.ais.values()].map((a) => a.L.id))], lvl: window.__pen.battle.aiLevel }));
const onC = await client.evaluate(() => window.__pen.battle.aiLevel);
check('AI tanks fill the room at hard', onH.tanks === 10 && onH.levels.length === 1 && onH.levels[0] === 'hard' && onH.lvl === 'hard', JSON.stringify(onH));
check('client knows the difficulty', onC === 'hard', onC);
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
log(ok ? 'ALL PASS' : 'SOME FAILED');
await browser.close();
process.exit(ok ? 0 : 1);
