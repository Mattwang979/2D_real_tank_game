// Tech tree screen.

import { formatNum } from '../core/math';
import { buy, get, save, setResearching, spendFreeRP, toggleLineup, vehicleState } from '../core/save';
import { CLASS_NAMES, VEHICLES, getVehicle, type Nation, type VehicleSpec } from '../data/vehicles';
import { NATION_FLAG, h, modal, toast, vehicleStats } from './common';
import { slotImage } from './hangar';
import { t } from './i18n';

const ROMAN = ['', 'I', 'II', 'III', 'IV'];

export class TechTree {
  el: HTMLElement;
  nation: Nation = 'usa';
  onBack: () => void = () => {};
  onView: (id: string) => void = () => {};
  private scroll!: HTMLElement;
  private grid!: HTMLElement;

  constructor(el: HTMLElement) {
    this.el = el;
  }

  refresh() {
    const s = get();
    this.el.innerHTML = '';
    const top = h(
      'div',
      { class: 'topbar' },
      h('button', { class: 'icon-btn', onclick: () => this.onBack(), 'aria-label': 'Back' }, '‹'),
      h('div', { class: 'logo' }, t('TECH TREE')),
      h('div', { class: 'cur cr' }, h('b', {}, 'CR'), h('i', {}, formatNum(s.credits))),
      h('div', { class: 'cur rp' }, h('b', {}, t('Free RP')), h('i', {}, formatNum(s.rpFree))),
    );
    const tabs = h('div', { class: 'tree-tabs' });
    for (const n of ['usa', 'germany', 'ussr'] as Nation[]) {
      tabs.append(
        h('button', {
          class: n === this.nation ? 'on' : '',
          onclick: () => {
            this.nation = n;
            this.refresh();
          },
        }, NATION_FLAG[n]),
      );
    }
    this.scroll = h('div', { class: 'tree-scroll' });
    this.grid = h('div', { class: 'tree-grid' });
    this.scroll.append(this.grid);
    this.el.append(top, tabs, this.scroll);
    this.buildGrid();
  }

  private buildGrid() {
    const list = VEHICLES.filter((v) => v.nation === this.nation);
    const rows = Math.max(...list.map((v) => v.row)) + 1;
    this.grid.style.gridTemplateRows = `auto repeat(${rows}, 104px)`;
    const maxTier = Math.max(...list.map((v) => v.tier));
    for (let tier = 1; tier <= maxTier; tier++) {
      const head = h('div', { class: 'tier-h', style: `grid-column:${tier};grid-row:1` }, `${t('TIER')} ${ROMAN[tier]}`);
      this.grid.append(head);
    }
    const s = get();
    const cards = new Map<string, HTMLElement>();
    for (const v of list) {
      const st = vehicleState(v.id);
      const researching = s.researching === v.id;
      const inLineup = s.lineup.includes(v.id);
      const c = h('canvas');
      const status = h('div', { class: 'vstatus' });
      if (st === 'owned') status.append(h('span', {}, t('Owned')));
      else if (st === 'researched') status.append(h('span', {}, `${t('Researched')} · ${formatNum(v.cr)} CR`));
      else {
        const prog = s.research[v.id] ?? 0;
        status.append(h('span', {}, `${formatNum(prog)} / ${formatNum(v.rp)} RP`), h('span', {}, st === 'locked' ? '🔒' : researching ? '▶' : ''));
      }
      const card = h(
        'div',
        { class: `vcard ${st} ${researching ? 'researching' : ''}`, style: `grid-column:${v.tier};grid-row:${v.row + 2}`, onclick: () => this.detail(v) },
        c,
        h('span', { class: 'br' }, `BR ${v.br.toFixed(1)}`),
        inLineup ? h('span', { class: 'tag' }, t('IN LINEUP')) : null,
        h('div', { class: 'vname' }, v.name),
        status,
      );
      if (st === 'researchable' || st === 'locked') {
        const prog = (s.research[v.id] ?? 0) / v.rp;
        card.append(h('div', { class: 'bar' }, h('i', { style: `width:${Math.round(prog * 100)}%` })));
      }
      cards.set(v.id, card);
      this.grid.append(card);
      requestAnimationFrame(() => slotImage(c, v, -Math.PI / 2 + 0.95, 0.85));
    }
    requestAnimationFrame(() => this.connectors(list, cards));
  }

  private connectors(list: VehicleSpec[], cards: Map<string, HTMLElement>) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'tree-svg');
    const gr = this.grid.getBoundingClientRect();
    svg.setAttribute('width', String(gr.width));
    svg.setAttribute('height', String(gr.height));
    const s = get();
    for (const v of list) {
      if (!v.prereq) continue;
      const a = cards.get(v.prereq);
      const b = cards.get(v.id);
      if (!a || !b) continue;
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const x0 = ra.right - gr.left;
      const y0 = ra.top + ra.height / 2 - gr.top;
      const x1 = rb.left - gr.left;
      const y1 = rb.top + rb.height / 2 - gr.top;
      const st = vehicleState(v.id);
      const col = s.researching === v.id ? '#e8a33c' : st === 'owned' || st === 'researched' ? '#2f9e7a' : st === 'researchable' ? '#3f8f72' : '#4a4f4c';
      const mx = x0 + 16;
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', Math.abs(y1 - y0) < 2 ? `M${x0},${y0} L${x1 - 9},${y1}` : `M${x0},${y0} L${mx},${y0} L${mx},${y1} L${x1 - 9},${y1}`);
      path.setAttribute('stroke', col);
      path.setAttribute('stroke-width', '2.5');
      path.setAttribute('fill', 'none');
      svg.append(path);
      const tri = document.createElementNS(NS, 'path');
      tri.setAttribute('d', `M${x1 - 11},${y1 - 7} L${x1 - 1},${y1} L${x1 - 11},${y1 + 7} Z`);
      tri.setAttribute('fill', col);
      svg.append(tri);
    }
    this.grid.prepend(svg);
  }

  detail(v: VehicleSpec) {
    const s = get();
    const st = vehicleState(v.id);
    const vs = vehicleStats(v);
    let close = () => {};
    const msg = h('div', { class: 'msg' });
    const c = h('canvas');
    const btns = h('div', { class: 'row' });
    const done = () => {
      close();
      this.refresh();
    };
    if (st === 'owned') {
      const inL = s.lineup.includes(v.id);
      btns.append(
        h('button', {
          class: 'btn',
          onclick: () => {
            const r = toggleLineup(v.id);
            if (r === 'full') msg.textContent = t('Lineup is full (3)');
            else done();
          },
        }, inL ? t('Remove from lineup') : t('Add to lineup')),
        h('button', {
          class: 'btn',
          onclick: () => {
            s.selected = v.id;
            if (!s.lineup.includes(v.id)) toggleLineup(v.id);
            save();
            close();
            this.onView(v.id);
          },
        }, t('View in hangar')),
      );
    } else if (st === 'researched') {
      btns.append(
        h('button', {
          class: 'btn primary',
          style: 'font-size:18px',
          onclick: () => {
            if (!buy(v.id)) msg.textContent = t('Not enough credits');
            else {
              const r = toggleLineup(v.id);
              toast(r === 'full' ? `${v.name} — ${t('Owned')} · ${t('Lineup is full (3)')}` : `${v.name} — ${t('Owned')} · ${t('IN LINEUP')}`);
              done();
            }
          },
        }, `${t('Buy')} · ${formatNum(v.cr)} CR`),
      );
    } else if (st === 'researchable') {
      btns.append(
        h('button', {
          class: 'btn',
          onclick: () => {
            setResearching(v.id);
            done();
          },
        }, s.researching === v.id ? `▶ ${t('Researching')}` : t('Research')),
      );
      if (s.rpFree > 0)
        btns.append(
          h('button', {
            class: 'btn',
            onclick: () => {
              spendFreeRP(v.id);
              if (vehicleState(v.id) === 'researched') toast(`${v.name} ${t('unlocked!')}`);
              done();
            },
          }, `${t('Use free RP')} (${formatNum(Math.min(s.rpFree, v.rp - (s.research[v.id] ?? 0)))})`),
        );
    } else {
      msg.textContent = t('Research the previous vehicle first');
    }
    btns.append(h('button', { class: 'btn', onclick: () => close() }, t('Close')));
    const prog = s.research[v.id] ?? 0;
    const content = h(
      'div',
      { class: 'detail' },
      c,
      h(
        'div',
        {},
        h('h2', {}, v.name),
        h('div', { style: 'display:flex;gap:6px;align-items:center;color:var(--dim);font-size:13px' }, h('span', { class: 'br' }, `BR ${v.br.toFixed(1)}`), `${NATION_FLAG[v.nation]} · ${t(CLASS_NAMES[v.cls])} · ${v.year}`),
        h(
          'div',
          { class: 'grid2', style: 'font-size:13px' },
          h('div', { class: 'stat' }, h('span', {}, t('Penetration')), h('b', {}, `${vs.pen} mm`)),
          h('div', { class: 'stat' }, h('span', {}, t('Reload')), h('b', {}, `${vs.reload.toFixed(1)} s`)),
          h('div', { class: 'stat' }, h('span', {}, t('Hull front')), h('b', {}, `${vs.hullFront} mm`)),
          h('div', { class: 'stat' }, h('span', {}, t('Turret front')), h('b', {}, `${vs.turretFront} mm`)),
          h('div', { class: 'stat' }, h('span', {}, t('Top speed')), h('b', {}, `${vs.speed} km/h`)),
          h('div', { class: 'stat' }, h('span', {}, t('Crew')), h('b', {}, `${v.crew.length}`)),
        ),
        h('div', { style: 'font-size:12px;color:var(--dim);margin-top:6px' }, `${v.gun.name} · ${v.gun.shells.map((x) => x.name).join(' / ')}`),
        st === 'researchable' || st === 'locked' ? h('div', { style: 'margin-top:6px;font-size:12px' }, `${t('Research progress')}: ${formatNum(prog)} / ${formatNum(v.rp)} RP`, h('div', { class: 'progress' }, h('i', { style: `width:${(prog / v.rp) * 100}%` }))) : null,
        msg,
        btns,
      ),
    );
    close = modal(content);
    requestAnimationFrame(() => slotImage(c, v, -Math.PI / 2 + 0.7, 1));
    void getVehicle;
  }
}
