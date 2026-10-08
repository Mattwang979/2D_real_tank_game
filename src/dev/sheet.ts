import '@fontsource/barlow-condensed/700.css';
import { VEHICLES, getVehicle } from '../data/vehicles';
import { drawTankVector, drawXray, drawArmorView } from '../render/tankRender';

const q = new URLSearchParams(location.search);
const mode = q.get('mode') ?? 'tank';
const ids = q.get('ids')?.split(',');
const list = ids ? ids.map(getVehicle) : VEHICLES;
const sc = +(q.get('scale') ?? 22);
const cols = +(q.get('cols') ?? 5);
const cv = document.getElementById('c') as HTMLCanvasElement;
const cw = sc * 4.2 + 20, ch = sc * 9 + 30;
cv.width = cols * cw; cv.height = Math.ceil(list.length / cols) * ch;
const ctx = cv.getContext('2d')!;
ctx.fillStyle = mode === 'tank' ? '#6b6a5c' : '#2a2b27'; ctx.fillRect(0, 0, cv.width, cv.height);
document.fonts.ready.then(() => {
list.forEach((v, i) => {
  const x = (i % cols) * cw + cw / 2, y = Math.floor(i / cols) * ch + ch / 2 + 10;
  ctx.save(); ctx.translate(x, y); ctx.scale(sc, sc); ctx.rotate(-Math.PI / 2);
  if (mode === 'tank') drawTankVector(ctx, v, 0, 0);
  else if (mode === 'xray') drawXray(ctx, v, { style: 'gold', labels: true, labelRot: Math.PI / 2 });
  else if (mode === 'gray') drawXray(ctx, v, { style: 'gray', labels: false });
  else drawArmorView(ctx, v, 0, Math.PI / 2);
  ctx.restore();
  ctx.fillStyle = '#eee'; ctx.font = '700 16px "Barlow Condensed"'; ctx.fillText(v.name + '  BR ' + v.br, (i % cols) * cw + 6, Math.floor(i / cols) * ch + 18);
});
});
