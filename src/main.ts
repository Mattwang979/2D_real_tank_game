import '@fontsource/barlow-condensed/400.css';
import '@fontsource/barlow-condensed/500.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/barlow-condensed/700-italic.css';
import './styles.css';

import { audio } from './core/audio';
import { get } from './core/save';
import { Battle } from './game/battle';
import { MAPS } from './game/map';
import { BattleRenderer } from './render/battleRender';
import { confirmBox, h, modal, settingsMenu } from './ui/common';
import { Hangar } from './ui/hangar';
import { Hud } from './ui/hud';
import { setLang, t } from './ui/i18n';
import { showResults } from './ui/results';
import { TechTree } from './ui/techtree';
import { Title } from './ui/title';

type ScreenId = 'title' | 'hangar' | 'tree' | 'battle' | 'results';

const app = document.getElementById('app')!;
const screens = {} as Record<ScreenId, HTMLElement>;
for (const id of ['title', 'hangar', 'tree', 'battle', 'results'] as ScreenId[]) {
  const el = h('div', { class: 'screen', id });
  screens[id] = el;
  app.append(el);
}
const loading = h('div', { id: 'loading' });
document.body.append(loading);

const settings = get().settings;
setLang(settings.lang);
audio.setVolume(settings.volume);

let current: ScreenId = 'title';
const title = new Title(screens.title);
const hangar = new Hangar(screens.hangar);
const tree = new TechTree(screens.tree);

function applyI18n() {
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n!);
  });
}

function show(id: ScreenId) {
  current = id;
  for (const [k, el] of Object.entries(screens)) el.classList.toggle('active', k === id);
  if (id === 'title') title.start();
  else title.stop();
  if (id === 'hangar') {
    hangar.refresh();
    hangar.start();
  } else hangar.stop();
  if (id === 'tree') tree.refresh();
}

function goFullscreen() {
  const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
  try {
    const p = el.requestFullscreen?.({ navigationUI: 'hide' } as FullscreenOptions);
    if (p && typeof p.then === 'function') {
      p.then(() => {
        const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
        o?.lock?.('landscape').catch(() => {});
      }).catch(() => {});
    } else el.webkitRequestFullscreen?.();
  } catch {
    /* not supported (iOS Safari) */
  }
}

title.onStart = () => {
  audio.unlock();
  goFullscreen();
  show('hangar');
};
hangar.onSettings = () =>
  settingsMenu(() => {
    setLang(get().settings.lang);
    applyI18n();
    if (current === 'hangar') hangar.refresh();
  });
hangar.onTree = () => show('tree');
hangar.onBattle = () => void startBattle();
tree.onBack = () => show('hangar');
tree.onView = () => show('hangar');

// ---------------------------------------------------------------- battle
let battle: Battle | null = null;
let renderer: BattleRenderer | null = null;
let hud: Hud | null = null;
let paused = false;
let endedAt = -1;
let rafId = 0;

async function startBattle() {
  const s = get();
  audio.unlock();
  const mapDef = s.settings.map === 'random' ? MAPS[Math.floor(Math.random() * MAPS.length)] : MAPS.find((m) => m.id === s.settings.map) ?? MAPS[0];
  loading.innerHTML = '';
  loading.append(h('div', { style: 'color:var(--dim);font-size:14px' }, t('Loading')), h('div', { class: 'mapname' }, t(mapDef.name).toUpperCase()), h('div', { class: 'bar' }, h('i')));
  loading.style.display = 'flex';
  await new Promise((r) => setTimeout(r, 60));
  const b = new Battle({ mapId: mapDef.id, lineup: s.lineup, playerName: s.playerName, seed: 1234 });
  show('battle');
  screens.battle.innerHTML = '';
  const canvas = h('canvas');
  screens.battle.append(canvas);
  await new Promise((r) => requestAnimationFrame(r));
  const r = new BattleRenderer(canvas, b, s.settings.quality);
  const hd = new Hud(b, r, canvas);
  hd.onPause = () => openPause();
  hd.onLeave = () => leaveBattle();
  battle = b;
  renderer = r;
  hud = hd;
  paused = false;
  endedAt = -1;
  audio.engineStart();
  loading.style.display = 'none';
  let last = performance.now();
  const frame = (now: number) => {
    if (battle !== b) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!paused) {
      hd.update(dt);
      const steps = dt > 1 / 45 ? 2 : 1;
      for (let i = 0; i < steps; i++) b.update(dt / steps);
      for (const ev of b.events) hd.handle(ev);
      b.events.length = 0;
    }
    r.render(paused ? 0 : dt);
    hd.draw(r.ctx);
    if (b.state === 'ended') {
      if (endedAt < 0) endedAt = now;
      else if (now - endedAt > 2600) {
        finishBattle();
        return;
      }
    }
    rafId = requestAnimationFrame(frame);
  };
  rafId = requestAnimationFrame(frame);
}

function openPause() {
  if (!battle) return;
  paused = true;
  let close = () => {};
  const c = h(
    'div',
    {},
    h('h2', {}, t('Paused')),
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'btn primary', style: 'font-size:18px', onclick: () => close() }, t('Resume')),
      h('button', {
        class: 'btn',
        onclick: () => {
          const st = get().settings;
          st.volume = st.volume > 0 ? 0 : 0.8;
          audio.setVolume(st.volume);
          close();
        },
      }, `${t('Sound')}: ${get().settings.volume > 0 ? t('On') : t('Off')}`),
      h('button', { class: 'btn danger', onclick: () => (close(), confirmBox(t('Leave battle'), () => leaveBattle())) }, t('Leave battle')),
    ),
  );
  close = modal(c, () => (paused = false));
}

function leaveBattle() {
  if (!battle) return;
  paused = false;
  if (battle.state !== 'ended') battle.end('defeat');
  finishBattle();
}

function finishBattle() {
  const b = battle;
  if (!b) return;
  cancelAnimationFrame(rafId);
  hud?.destroy();
  audio.engineStop();
  battle = null;
  renderer = null;
  hud = null;
  show('results');
  showResults(screens.results, b, () => show('hangar'));
}

window.addEventListener('resize', () => {
  renderer?.resize();
  hud?.readSafe();
  if (current === 'hangar') hangar.resize();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && battle && !paused && battle.state === 'playing') openPause();
});

show('title');
applyI18n();

// Debug / automation hook
(window as unknown as { __pen: unknown }).__pen = {
  get battle() {
    return battle;
  },
  get renderer() {
    return renderer;
  },
  get hud() {
    return hud;
  },
  show,
  startBattle,
  save: get,
};
