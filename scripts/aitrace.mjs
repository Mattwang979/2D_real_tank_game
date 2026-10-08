// Run a battle headlessly and plot every tank's trajectory on a map image.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const [out, map = 'city', secs = '360'] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://localhost:5173/');
await page.waitForTimeout(600);
await page.evaluate((m) => { window.__pen.save().settings.map = m; }, map);
await page.evaluate(() => window.__pen.startBattle());
await page.waitForTimeout(1200);
const data = await page.evaluate(async (secs) => {
  const b = window.__pen.battle; const hud = window.__pen.hud;
  hud.autoInput = (p) => { p.throttle = 0; p.steer = 0; };
  const tracks = new Map(); const deaths = []; let stuckSamples = 0, samples = 0;
  for (let i = 0; i < secs * 30; i++) {
    b.update(1 / 30);
    for (const ev of b.events) if (ev.type === 'feed') deaths.push([ev.victim.pos.x, ev.victim.pos.y, ev.victim.team]);
    b.events.length = 0;
    if (i % 15 === 0) for (const t of b.tanks) { if (!t.alive) continue; if (!tracks.has(t.id)) tracks.set(t.id, { team: t.team, pts: [] }); tracks.get(t.id).pts.push([t.pos.x, t.pos.y]); }
    if (i % 30 === 0) for (const [, ai] of b.ais) { samples++; if (ai.reverse > 0) stuckSamples++; }
    if (b.state === 'ended') break;
  }
  // render
  const c = document.createElement('canvas'); c.width = 880; c.height = 880; const g = c.getContext('2d'); const k = 880 / b.map.size;
  g.fillStyle = b.map.theme === 'city' ? '#4a4844' : b.map.theme === 'desert' ? '#a8956d' : '#4c5a37'; g.fillRect(0, 0, 880, 880);
  g.scale(k, k);
  for (const r of b.map.roads) { g.strokeStyle = 'rgba(30,30,30,0.6)'; g.lineWidth = r.w; g.beginPath(); r.pts.forEach((p, i) => i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)); g.stroke(); }
  g.fillStyle = '#9a9184'; for (const bd of b.map.buildings) { g.beginPath(); bd.poly.forEach((p, i) => i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)); g.fill(); }
  g.fillStyle = 'rgba(20,40,15,0.8)'; for (const t of b.map.trees) { g.beginPath(); g.arc(t.x, t.y, t.r * 0.7, 0, 7); g.fill(); }
  g.fillStyle = '#6d665a'; for (const r of b.map.rocks) { g.beginPath(); g.arc(r.x, r.y, r.r, 0, 7); g.fill(); }
  g.strokeStyle = '#fff'; g.lineWidth = 0.8; g.beginPath(); g.arc(b.map.capture.x, b.map.capture.y, b.map.capture.r, 0, 7); g.stroke();
  for (const [, tr] of tracks) { g.strokeStyle = tr.team === 0 ? 'rgba(90,160,255,0.8)' : 'rgba(255,90,70,0.8)'; g.lineWidth = 0.9; g.beginPath(); tr.pts.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.stroke(); }
  for (const d of deaths) { g.fillStyle = '#ffd200'; g.beginPath(); g.arc(d[0], d[1], 2.5, 0, 7); g.fill(); }
  return { img: c.toDataURL('image/png'), time: b.time.toFixed(0), result: b.result, tickets: b.tickets.map(Math.round), deaths: deaths.length, stuckPct: (100 * stuckSamples / Math.max(1, samples)).toFixed(1) };
}, +secs);
const fs = await import('fs');
fs.writeFileSync(`${out}/aitrace_${map}.png`, Buffer.from(data.img.split(',')[1], 'base64'));
delete data.img; console.log(map, JSON.stringify(data));
await browser.close();
