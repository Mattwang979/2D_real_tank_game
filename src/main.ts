import '@fontsource/barlow-condensed/400.css';
import '@fontsource/barlow-condensed/500.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/barlow-condensed/700-italic.css';
import './styles.css';

import { audio } from './core/audio';
import { get } from './core/save';
import { Battle } from './game/battle';
import { MAPS, type MapDef } from './game/map';
import { pickWeather, WEATHERS, type WeatherId } from './game/weather';
import type { ClientGame, ClientRoom, HostRoom, NetSession } from './net/session';
import { BattleRenderer } from './render/battleRender';
import { confirmBox, h, modal, settingsMenu, toast } from './ui/common';
import { Hangar } from './ui/hangar';
import { Hud } from './ui/hud';
import { setLang, t } from './ui/i18n';
import { Lobby } from './ui/lobby';
import { showResults } from './ui/results';
import { TechTree } from './ui/techtree';
import { Title } from './ui/title';

type ScreenId = 'title' | 'hangar' | 'tree' | 'battle' | 'results' | 'lobby';

const app = document.getElementById('app')!;
const screens = {} as Record<ScreenId, HTMLElement>;
for (const id of ['title', 'hangar', 'tree', 'battle', 'results', 'lobby'] as ScreenId[]) {
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
const lobby = new Lobby(screens.lobby);

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

// invite links: ?room=CODE opens the lobby and joins that room
const inviteCode = new URLSearchParams(location.search).get('room');

title.onStart = () => {
  audio.unlock();
  goFullscreen();
  if (inviteCode) {
    const q = new URLSearchParams(location.search);
    q.delete('room');
    history.replaceState(null, '', `${location.pathname}${q.toString() ? `?${q}` : ''}`);
    openLobby(inviteCode);
  } else show('hangar');
};
hangar.onSettings = () =>
  settingsMenu(() => {
    setLang(get().settings.lang);
    applyI18n();
    if (current === 'hangar') hangar.refresh();
  });
hangar.onTree = () => show('tree');
hangar.onBattle = () => void startBattle();
hangar.onMultiplayer = () => openLobby();
lobby.onBack = () => show('hangar');
lobby.onHostStart = (room) => void startHostBattle(room);
lobby.onClientStart = (room, game) => void startClientBattle(room, game);

function openLobby(code?: string) {
  show('lobby');
  lobby.show(code);
}
tree.onBack = () => show('hangar');
tree.onView = () => show('hangar');

// ---------------------------------------------------------------- battle
let battle: Battle | null = null;
let renderer: BattleRenderer | null = null;
let hud: Hud | null = null;
let net: NetSession | null = null;
let paused = false;
let endedAt = -1;
let rafId = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function showLoading(def: MapDef, weather?: WeatherId) {
  loading.innerHTML = '';
  const w = weather ? WEATHERS[weather] : null;
  loading.append(h('div', { style: 'color:var(--dim);font-size:14px' }, t('Loading')), h('div', { class: 'mapname' }, t(def.name).toUpperCase()));
  if (w) loading.append(h('div', { class: 'mapweather' }, `${w.icon} ${t(w.name)} · ${t(w.info)}`));
  loading.append(h('div', { class: 'bar' }, h('i')));
  loading.style.display = 'flex';
  await sleep(60);
}

async function startBattle() {
  const s = get();
  audio.unlock();
  const mapDef = s.settings.map === 'random' ? MAPS[Math.floor(Math.random() * MAPS.length)] : MAPS.find((m) => m.id === s.settings.map) ?? MAPS[0];
  const weather = pickWeather(s.settings.weather);
  await showLoading(mapDef, weather);
  const b = new Battle({ mapId: mapDef.id, lineup: s.lineup, playerName: s.playerName, seed: 1234, weather });
  await runBattle(b, null);
}

async function startHostBattle(room: HostRoom) {
  audio.unlock();
  lobby.inBattle = true;
  const b = room.start();
  await showLoading(b.map.def, b.weather.id);
  await runBattle(b, room.game);
}

async function startClientBattle(room: ClientRoom, game: ClientGame) {
  audio.unlock();
  lobby.inBattle = true;
  if (current === 'battle') return; // already in a battle (should not happen)
  await showLoading(game.b.map.def, game.b.weather.id);
  const ok = await Promise.race([game.ready.then(() => true), sleep(10000).then(() => false)]);
  if (!ok || room.phase === 'closed') {
    loading.style.display = 'none';
    toast(t('Could not sync with the host'));
    lobby.leaveRoom();
    openLobby();
    return;
  }
  await runBattle(game.b, game);
}

async function runBattle(b: Battle, session: NetSession | null) {
  const s = get();
  show('battle');
  screens.battle.innerHTML = '';
  const canvas = h('canvas');
  screens.battle.append(canvas);
  await new Promise((r) => requestAnimationFrame(r));
  const r = new BattleRenderer(canvas, b, s.settings.quality);
  const hd = new Hud(b, r, canvas, session?.controls);
  hd.onPause = () => openPause();
  if (s.stats.battles < 3) hd.tutorial = 14;
  hd.onLeave = () => leaveBattle();
  battle = b;
  renderer = r;
  hud = hd;
  net = session;
  paused = false;
  endedAt = -1;
  audio.engineStart();
  audio.ambience(b.weather.id === 'rain' ? 'rain' : null);
  loading.style.display = 'none';
  let last = performance.now();
  let slow = 0;
  const frame = (now: number) => {
    if (battle !== b) return;
    const raw = (now - last) / 1000;
    const dt = Math.min(0.05, raw);
    last = now;
    // automatic quality fallback when the device can't keep ~40 fps
    if (!paused && r.quality === 'high' && raw < 0.5) {
      slow = raw > 1 / 38 ? slow + raw : Math.max(0, slow - raw * 0.5);
      if (slow > 4) {
        r.quality = 'low';
        r.resize();
        hd.handle({ type: 'notice', text: 'Graphics: Low (auto)', color: '#9fd3ff' });
      }
    }
    // multiplayer never pauses the simulation
    const simPaused = paused && !session;
    if (!simPaused) {
      hd.update(dt);
      session?.beforeUpdate(dt);
      const steps = dt > 1 / 45 ? 2 : 1;
      for (let i = 0; i < steps; i++) b.update(dt / steps);
      session?.afterUpdate(dt, b.events);
      for (const ev of b.events) hd.handle(ev);
      b.events.length = 0;
    }
    hd.netInfo = session ? session.info() : null;
    r.render(simPaused ? 0 : dt);
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
  const mp = !!net;
  paused = true;
  if (!mp) audio.pause();
  let close = () => {};
  const c = h(
    'div',
    {},
    h('h2', {}, mp ? t('Menu') : t('Paused')),
    mp ? h('div', { style: 'color:var(--dim);font-size:13px' }, t('Multiplayer battles keep running.')) : null,
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
      h('button', { class: 'btn danger', onclick: () => (close(), confirmBox(net?.isHost ? t('Leaving ends the battle for everyone') : t('Leave battle'), () => leaveBattle())) }, t('Leave battle')),
    ),
  );
  close = modal(c, () => {
    paused = false;
    if (!mp) audio.resume();
  });
}

function leaveBattle() {
  if (!battle) return;
  paused = false;
  if (net) {
    net.leave();
    lobby.leaveRoom();
  }
  if (battle.state !== 'ended') battle.end('defeat');
  finishBattle();
}

function finishBattle() {
  const b = battle;
  if (!b) return;
  cancelAnimationFrame(rafId);
  hud?.destroy();
  audio.engineStop();
  audio.ambience(null);
  battle = null;
  renderer = null;
  hud = null;
  net = null;
  show('results');
  showResults(screens.results, b, () => {
    if (lobby.active) {
      lobby.host?.backToLobby();
      lobby.client?.backToLobby();
      openLobby();
    } else show('hangar');
  });
}

window.addEventListener('resize', () => {
  renderer?.resize();
  hud?.readSafe();
  if (current === 'hangar') hangar.resize();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && battle && !net && !paused && battle.state === 'playing') openPause();
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
  get net() {
    return net;
  },
  lobby,
  show,
  startBattle,
  openLobby,
  save: get,
};
