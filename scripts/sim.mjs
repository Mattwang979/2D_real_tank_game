// Fast headless battle simulation (no rendering) to validate AI + rules.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const [map = 'valley', seconds = '400'] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 844, height: 390 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message, e.stack?.split('\n').slice(0, 5).join(' | ')));
await page.goto('http://localhost:5173/');
await page.waitForTimeout(800);
await page.evaluate((m) => { const s = window.__pen.save(); s.settings.map = m; }, map);
await page.evaluate(() => window.__pen.startBattle());
await page.waitForTimeout(1500);
const res = await page.evaluate(async (secs) => {
  const P = window.__pen; const b = P.battle; const hud = P.hud;
  // player drives with the AI controller logic: let it just sit near spawn & shoot
  hud.autoInput = (p) => {
    const c = b.map.capture; const want = Math.atan2(c.y - p.pos.y, c.x - p.pos.x);
    let d = want - p.ang; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    const far = Math.hypot(c.x - p.pos.x, c.y - p.pos.y) > 60;
    p.throttle = far ? 1 : 0; p.steer = Math.max(-1, Math.min(1, d * 2));
    let best = null, bd = 1e9;
    for (const e of b.tanks) { if (!e.alive || e.team === p.team || !b.isSpotted(p.team, e)) continue; const dd = Math.hypot(e.pos.x - p.pos.x, e.pos.y - p.pos.y); if (dd < bd) { bd = dd; best = e; } }
    if (best) { p.aimAngle = Math.atan2(best.pos.y - p.pos.y, best.pos.x - p.pos.x); if (p.isReloaded() && p.aimError() < 0.015) b.playerFire(); }
  };
  const log = []; const out = {}; const dists = [];
  const t0 = performance.now();
  let lastFeed = 0;
  for (let i = 0; i < secs * 30; i++) {
    hud.update(1 / 30);
    b.update(1 / 30);
    for (const ev of b.events) {
      if (ev.type === 'feed') log.push(`${b.time.toFixed(0)}s ${ev.killer ? ev.killer.team + ':' + ev.killer.spec.id : '-'} -> ${ev.victim.team}:${ev.victim.spec.id} (${ev.how})`);
      if (ev.type === 'hit') { const k = ev.res.outcome + (ev.res.outcome === 'pen' ? (ev.res.damage > 0 ? '+dmg' : '-nodmg') : ''); out[k] = (out[k] || 0) + 1; dists.push(Math.round(Math.hypot(ev.shooter.pos.x - ev.target.pos.x, ev.shooter.pos.y - ev.target.pos.y))); }
      if (ev.type === 'captured') log.push(`${b.time.toFixed(0)}s CAPTURED by ${ev.team}`);
      if (ev.type === 'playerDead') { log.push(`${b.time.toFixed(0)}s PLAYER DEAD`); const av = b.availableLineup(); if (av.length) { b.deadAt = -10; b.respawnPlayer(av[0].id); log.push('respawn ' + av[0].id); } }
    }
    b.events.length = 0;
    if (b.state === 'ended') break;
  }
  const ms = performance.now() - t0;
  const ais = [...b.ais.values()].map(a => ({ id: a.tank.spec.id, team: a.tank.team, pos: [a.tank.pos.x|0, a.tank.pos.y|0], goal: a.goal && [a.goal.x|0, a.goal.y|0], path: a.path.length, role: a.role, tgt: a.target && a.target.spec.id, rev: a.reverse > 0 }));
  return { simMs: Math.round(ms), time: b.time.toFixed(0), state: b.state, result: b.result, playerTeam: b.playerTeam, tickets: b.tickets.map(Math.round), reinf: b.reinforcements, stats: b.stats, totals: b.totals(), log: log.slice(0, 60), ais, outcomes: out, medDist: dists.sort((a,b)=>a-b)[dists.length>>1], maxDist: Math.max(...dists), shots: b.tanks.reduce((a, t) => a + t.spec.gun.shells.reduce((x, s, i) => x + (s.count - t.ammo[i]), 0), 0) };
}, +seconds);
console.log(JSON.stringify(res, null, 1));
await browser.close();
