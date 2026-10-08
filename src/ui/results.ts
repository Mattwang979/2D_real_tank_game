// Post-battle results: rewards breakdown, research progress.

import { formatNum } from '../core/math';
import { addRP, get, save } from '../core/save';
import { getVehicle } from '../data/vehicles';
import type { Battle } from '../game/battle';
import { h, toast } from './common';
import { t } from './i18n';

export function showResults(el: HTMLElement, b: Battle, onContinue: () => void) {
  const s = get();
  const tot = b.totals();
  const researchingBefore = s.researching;
  const progBefore = researchingBefore ? s.research[researchingBefore] ?? 0 : 0;
  s.credits += tot.cr;
  s.stats.battles++;
  if (b.result === 'victory') s.stats.wins++;
  s.stats.kills += b.stats.kills;
  const unlocked = addRP(tot.rp);
  save();

  // collapse reward lines by label
  const agg = new Map<string, { n: number; rp: number; cr: number }>();
  for (const r of b.rewards) {
    const a = agg.get(r.label) ?? { n: 0, rp: 0, cr: 0 };
    a.n++;
    a.rp += r.rp;
    a.cr += r.cr;
    agg.set(r.label, a);
  }
  const lines = h('div', { class: 'res-lines' });
  for (const [label, a] of agg) {
    lines.append(h('div', { class: 'ln' }, h('span', {}, `${t(label)}${a.n > 1 ? ` ×${a.n}` : ''}`), h('span', {}, `+${formatNum(a.rp)} RP  ·  +${formatNum(a.cr)} CR`)));
  }
  if (b.result === 'victory') lines.append(h('div', { class: 'ln' }, h('span', {}, `${t('VICTORY')} ×1.2`), h('span', {}, '')));

  const win = b.result === 'victory';
  const research = h('div', { style: 'margin-top:10px' });
  if (researchingBefore) {
    const v = getVehicle(researchingBefore);
    const after = unlocked === researchingBefore ? v.rp : s.research[researchingBefore] ?? 0;
    const bar = h('i', { style: `width:${(progBefore / v.rp) * 100}%` });
    research.append(h('div', { class: 'label' }, `${t('Research progress')} — ${v.name}`), h('div', { class: 'progress' }, bar), h('div', { style: 'font-size:13px;margin-top:3px;color:var(--dim)' }, `${formatNum(after)} / ${formatNum(v.rp)} RP`));
    requestAnimationFrame(() => requestAnimationFrame(() => (bar.style.width = `${Math.min(100, (after / v.rp) * 100)}%`)));
  } else {
    research.append(h('div', { style: 'font-size:13px;color:var(--dim)' }, `${t('Free RP')}: ${formatNum(s.rpFree)}`));
  }

  el.innerHTML = '';
  el.append(
    h(
      'div',
      { class: 'res-wrap' },
      h(
        'div',
        {},
        h('div', { class: `res-title ${win ? 'win' : 'lose'}` }, t(win ? 'VICTORY' : 'DEFEAT')),
        h('div', { style: 'color:var(--dim);font-size:15px;margin-top:4px' }, `${t(b.map.def.name)} · ${b.player ? b.player.spec.name : ''}`),
        h(
          'div',
          { class: 'res-stats' },
          stat(t('Kills'), b.stats.kills),
          stat(t('Assists'), b.stats.assists),
          stat(t('Hits'), b.stats.hits + b.stats.crits),
          stat(t('Captures'), b.stats.caps),
          stat(t('Shots'), b.stats.shots),
          stat('RP', formatNum(tot.rp)),
        ),
        research,
        h('button', { class: 'btn primary', style: 'margin-top:12px;width:100%', onclick: () => onContinue() }, t('Continue')),
      ),
      h('div', {}, lines, h('div', { class: 'res-total' }, h('span', {}, t('Total')), h('span', { style: 'color:var(--orange)' }, `+${formatNum(tot.rp)} RP · +${formatNum(tot.cr)} CR`))),
    ),
  );
  if (unlocked) setTimeout(() => toast(`${getVehicle(unlocked).name} ${t('unlocked!')}`), 900);
}

function stat(label: string, v: string | number) {
  return h('div', {}, h('b', {}, String(v)), h('span', {}, label));
}
