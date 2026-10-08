// Armor model sanity checks run in the browser against the real modules.
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://localhost:5173/');
await page.waitForTimeout(500);
const out = await page.evaluate(async () => {
  const A = await import('/src/game/armor.ts');
  const { Tank } = await import('/src/game/tank.ts');
  const { getVehicle } = await import('/src/data/vehicles.ts');
  const rows = [];
  // shooter at distance d, target facing shooter rotated by yaw (deg), aim at a local point on target
  const test = (shooterId, shellIdx, targetId, d, yawDeg, aimLocal, label) => {
    const s = new Tank(getVehicle(shooterId), 0, { x: 0, y: 0 }, 0, 's');
    const t = new Tank(getVehicle(targetId), 1, { x: d, y: 0 }, Math.PI + (yawDeg * Math.PI) / 180, 't');
    const c = Math.cos(t.ang), sn = Math.sin(t.ang);
    const aim = { x: t.pos.x + aimLocal.x * c - aimLocal.y * sn, y: t.pos.y + aimLocal.x * sn + aimLocal.y * c };
    const from = { x: 0, y: 0 };
    const dl = Math.hypot(aim.x, aim.y);
    const dir = { x: aim.x / dl, y: aim.y / dl };
    const pr = A.predictShot(s, t, s.spec.gun.shells[shellIdx], from, dir);
    rows.push(`${label.padEnd(46)} ${pr.label.padEnd(20)} eff ${String(Math.round(pr.eff)).padStart(4)}  pen ${String(Math.round(pr.pen)).padStart(4)}  -> ${pr.outcome}`);
  };
  const front = { x: 0, y: 0 };       // centre mass (turret)
  const hullFront = (id) => ({ x: getVehicle(id).look.L * 0.45, y: getVehicle(id).look.W * 0.38 });
  test('m4a2', 0, 'tiger1', 300, 0, front, 'Sherman M61 → Tiger turret, 300m');
  test('m4a2', 0, 'tiger1', 300, 0, hullFront('tiger1'), 'Sherman M61 → Tiger hull front, 300m');
  test('m4a2', 0, 'tiger1', 200, 90, { x: -1, y: 1.8 }, 'Sherman M61 → Tiger side, 200m');
  test('tiger1', 0, 'm4a2', 800, 0, hullFront('m4a2'), 'Tiger PzGr39 → Sherman UFP, 800m');
  test('tiger1', 0, 't3485', 500, 0, hullFront('t3485'), 'Tiger PzGr39 → T-34-85 UFP, 500m');
  test('t3485', 0, 'pantherD', 300, 0, hullFront('pantherD'), 'T-34-85 BR-365 → Panther UFP, 300m');
  test('t3485', 0, 'pantherD', 300, 0, front, 'T-34-85 BR-365 → Panther turret, 300m');
  test('pantherG', 0, 'is2', 500, 0, hullFront('is2'), 'Panther PzGr39/42 → IS-2 UFP, 500m');
  test('is2', 0, 'tiger1', 1000, 0, front, 'IS-2 BR-471 → Tiger turret, 1000m');
  test('m4a2', 0, 't34_41', 200, 70, hullFront('t34_41'), 'Sherman → T-34 UFP at 70° yaw (ricochet?)');
  test('m4a3_76', 1, 'tiger1', 300, 0, hullFront('tiger1'), 'M4A3(76) HVAP → Tiger hull front, 300m');
  test('pz4h', 1, 'is1', 200, 0, hullFront('is1'), 'Pz IV PzGr40 → IS-1 hull front, 200m');
  test('m26', 0, 'pantherG', 400, 0, front, 'M26 M82 → Panther G turret, 400m');
  test('m24', 2, 'm10', 150, 0, front, 'M24 HE → M10 turret (open top)');
  // full impact resolution statistics
  const stat = (shooterId, shellIdx, targetId, d, yaw, aimLocal, label, n = 300) => {
    let pen = 0, kill = 0, ric = 0, cook = 0, fire = 0;
    for (let i = 0; i < n; i++) {
      const s = new Tank(getVehicle(shooterId), 0, { x: 0, y: 0 }, 0, 's');
      const t = new Tank(getVehicle(targetId), 1, { x: d, y: 0 }, Math.PI + (yaw * Math.PI) / 180, 't');
      const c = Math.cos(t.ang), sn = Math.sin(t.ang);
      const aim = { x: t.pos.x + aimLocal.x * c - aimLocal.y * sn, y: t.pos.y + aimLocal.x * sn + aimLocal.y * c };
      const dl = Math.hypot(aim.x, aim.y); const dir = { x: aim.x / dl, y: aim.y / dl };
      const hit = A.intersectTank(t, { x: 0, y: 0 }, { x: dir.x * 2000, y: dir.y * 2000 }, Math.random(), 1, true);
      if (!hit) continue;
      const r = A.resolveImpact(s, t, s.spec.gun.shells[shellIdx], hit, d, dir);
      if (r.outcome === 'pen') pen++; if (r.outcome === 'ricochet') ric++; if (r.killed) kill++; if (r.cookoff) cook++; if (r.fire) fire++;
    }
    rows.push(`${label.padEnd(46)} pen ${(pen/n*100).toFixed(0)}%  one-shot ${(kill/n*100).toFixed(0)}%  cook-off ${(cook/n*100).toFixed(0)}%  fire ${(fire/n*100).toFixed(0)}%  ric ${(ric/n*100).toFixed(0)}%`);
  };
  rows.push('--- 300 shots each ---');
  stat('tiger1', 0, 'm4a2', 500, 0, { x: 0.5, y: 0 }, 'Tiger → Sherman centre mass, 500m');
  stat('m4a2', 0, 'pz4h', 300, 0, { x: 0.5, y: 0 }, 'Sherman → Pz IV centre mass, 300m');
  stat('t34_41', 0, 'pz4h', 300, 60, { x: -0.5, y: 1.2 }, 'T-34 BR-350A → Pz IV side, 300m');
  stat('m4a2', 1, 'pz4h', 300, 60, { x: -0.5, y: 1.2 }, 'Sherman M72 solid AP → Pz IV side, 300m');
  stat('is2', 0, 'pantherG', 600, 0, { x: 0.3, y: 0 }, 'IS-2 BR-471 → Panther front, 600m');
  stat('pz4h', 0, 'm4a2', 400, 30, { x: 0.5, y: 0 }, 'Pz IV → Sherman 30° angled, 400m');
  return rows.join('\n');
});
console.log(out);
await browser.close();
