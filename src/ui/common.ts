// Small DOM helpers shared by the menu screens.

import { audio } from '../core/audio';
import { voice } from '../core/voice';
import { get, reset, save } from '../core/save';
import { VEHICLES, type VehicleSpec, penAt } from '../data/vehicles';
import { getLang, setLang, t } from './i18n';
import { isWeatherId, WEATHER_IDS, WEATHERS } from '../game/weather';

type Attrs = Record<string, string | number | boolean | ((e: Event) => void) | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: Array<Node | string | null | undefined | false>): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      const ev = k.slice(2).toLowerCase();
      el.addEventListener(ev, (e) => {
        if (ev === 'click') audio.click();
        (v as (e: Event) => void)(e);
      });
    } else if (k === 'class') el.className = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (k === 'html') el.innerHTML = String(v);
    else el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(c));
  return el;
}

export function toast(text: string) {
  const el = h('div', { class: 'toast' }, text);
  document.body.append(el);
  setTimeout(() => el.remove(), 2700);
}

export function modal(content: HTMLElement, onClose?: () => void): () => void {
  const bg = h('div', { class: 'modal-bg' });
  const box = h('div', { class: 'modal' });
  box.append(content);
  bg.append(box);
  const close = () => {
    bg.remove();
    onClose?.();
  };
  bg.addEventListener('pointerdown', (e) => {
    if (e.target === bg) close();
  });
  document.body.append(bg);
  return close;
}

/** Icon + name of a weather choice ('random' or a weather id). */
export function weatherLabel(id: string): string {
  if (!isWeatherId(id)) return `🎲 ${t('Random weather')}`;
  const w = WEATHERS[id];
  return `${w.icon} ${t(w.name)}`;
}

/** Weather choice chip; tapping it opens the picker (read-only when `onPick` is null). */
export function weatherChip(cur: string, onPick: ((id: string) => void) | null): HTMLElement {
  if (!onPick) return h('span', { class: 'wx-chip ro' }, weatherLabel(cur));
  return h('button', { class: 'wx-chip', onclick: () => weatherPicker(cur, onPick) }, `${weatherLabel(cur)} ▾`);
}

export function weatherPicker(cur: string, onPick: (id: string) => void) {
  let close = () => {};
  const opt = (id: string, title: string, info: string) =>
    h('button', { class: id === cur ? 'on' : '', onclick: () => (close(), onPick(id)) }, h('b', {}, title), h('i', {}, info));
  const c = h(
    'div',
    {},
    h('h2', {}, t('Weather')),
    h('div', { class: 'wx-pick' }, opt('random', weatherLabel('random'), t('Clear, rain, fog or night')), ...WEATHER_IDS.map((id) => opt(id, weatherLabel(id), t(WEATHERS[id].info)))),
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => close() }, t('Close'))),
  );
  close = modal(c);
}

export function confirmBox(text: string, yes: () => void) {
  let close = () => {};
  const c = h(
    'div',
    {},
    h('h2', {}, t('Are you sure?')),
    h('div', { style: 'color:var(--dim);font-size:15px' }, text),
    h('div', { class: 'row' }, h('button', { class: 'btn danger', onclick: () => (close(), yes()) }, 'OK'), h('button', { class: 'btn', onclick: () => close() }, t('Back'))),
  );
  close = modal(c);
}

export function settingsMenu(onChange: () => void) {
  const s = get().settings;
  let close = () => {};
  const seg = (opts: Array<[string, string]>, cur: string, set: (v: string) => void) => {
    const wrap = h('div', { class: 'seg' });
    for (const [v, label] of opts) {
      const b = h('button', { class: v === cur ? 'on' : '', onclick: () => {
        set(v);
        [...wrap.children].forEach((c) => c.classList.remove('on'));
        b.classList.add('on');
        save();
        onChange();
      } }, label);
      wrap.append(b);
    }
    return wrap;
  };
  const name = h('input', { type: 'text', value: get().playerName, maxlength: 16 }) as HTMLInputElement;
  name.addEventListener('change', () => {
    get().playerName = name.value.trim() || 'Commander';
    save();
  });
  const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: s.volume }) as HTMLInputElement;
  vol.addEventListener('input', () => {
    s.volume = parseFloat(vol.value);
    audio.setVolume(s.volume);
    voice.volume = s.volume;
    save();
  });
  const c = h(
    'div',
    {},
    h('h2', {}, t('Settings')),
    h(
      'div',
      { class: 'grid2' },
      h('div', { class: 'label' }, t('Language')),
      seg([['en', 'English'], ['zh', '繁體中文']], getLang(), (v) => {
        s.lang = v as 'en' | 'zh';
        setLang(s.lang);
      }),
      h('div', { class: 'label' }, t('Graphics')),
      seg([['high', t('High')], ['low', t('Low')]], s.quality, (v) => (s.quality = v as 'high' | 'low')),
      h('div', { class: 'label' }, t('Volume')),
      vol,
      h('div', { class: 'label' }, t('Voice callouts')),
      seg([['on', t('On')], ['off', t('Off')]], s.voice ? 'on' : 'off', (v) => {
        s.voice = v === 'on';
        voice.enabled = s.voice;
      }),
      h('div', { class: 'label' }, t('Vibration')),
      seg([['on', t('On')], ['off', t('Off')]], s.haptics ? 'on' : 'off', (v) => {
        s.haptics = v === 'on';
      }),
      h('div', { class: 'label' }, t('Player name')),
      name,
    ),
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'btn', onclick: () => close() }, t('Close')),
      h('button', { class: 'btn danger small', onclick: () => confirmBox(t('Reset progress'), () => (reset(), close(), onChange())) }, t('Reset progress')),
    ),
    h('div', { style: 'margin-top:10px;font-size:11px;color:#6d7068;line-height:1.4' }, 'PENETRATION — top-down WWII tank combat. Vehicle data are historical approximations. All art and sound are generated procedurally.'),
  );
  close = modal(c, onChange);
}

// ------------------------------------------------------------------ vehicle stats helpers
export function effArmor(p: { t: number; s: number }): number {
  return Math.round(p.t / Math.cos((p.s * Math.PI) / 180));
}

export function vehicleStats(v: VehicleSpec) {
  const best = Math.max(...v.gun.shells.map((s) => penAt(s, 100)));
  return {
    pen: Math.round(best),
    reload: v.gun.reload,
    hullFront: effArmor(v.armor.ufp),
    turretFront: Math.max(effArmor(v.armor.tFront), v.armor.mantlet.t),
    side: v.armor.side.t,
    speed: v.speed,
    pw: Math.round((v.hp / v.weight) * 10) / 10,
  };
}

export const NATION_FLAG: Record<string, string> = { usa: 'USA', germany: 'GERMANY', ussr: 'USSR' };

export function allVehicles() {
  return VEHICLES;
}
