// Multiplayer lobby: create a room (you host the battle) or join one with a 5-letter code.

import { get, save } from '../core/save';
import { getVehicle } from '../data/vehicles';
import { MAPS } from '../game/map';
import { NetError, normCode } from '../net/peer';
import { type ClientGame, ClientRoom, HostRoom, type RejectReason, TEAM_MAX } from '../net/session';
import type { LobbyPlayer } from '../net/protocol';
import { h, modal, toast } from './common';
import { t } from './i18n';

export class Lobby {
  el: HTMLElement;
  host: HostRoom | null = null;
  client: ClientRoom | null = null;
  onBack: () => void = () => {};
  onHostStart: (room: HostRoom) => void = () => {};
  onClientStart: (room: ClientRoom, game: ClientGame) => void = () => {};
  /** true while a battle of this room is running (lobby re-renders are suppressed) */
  inBattle = false;
  private busyToken = 0;

  constructor(el: HTMLElement) {
    this.el = el;
  }

  get active(): boolean {
    return !!(this.host || this.client);
  }

  /** Entry point: show the room if one is open, else the create / join menu. */
  show(joinCode?: string) {
    this.inBattle = false;
    if (this.host || this.client) this.renderRoom();
    else if (joinCode) void this.join(joinCode);
    else this.renderMenu();
  }

  // ------------------------------------------------------------------ menu
  private renderMenu(err?: string) {
    const s = get();
    const code = h('input', { type: 'text', class: 'lb-codein', maxlength: 5, placeholder: 'ABCDE', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false' }) as HTMLInputElement;
    code.addEventListener('input', () => {
      code.value = normCode(code.value);
    });
    const name = h('input', { type: 'text', value: s.playerName, maxlength: 16 }) as HTMLInputElement;
    name.addEventListener('change', () => {
      s.playerName = name.value.trim() || 'Commander';
      save();
    });
    this.el.innerHTML = '';
    this.el.append(
      h(
        'div',
        { class: 'lobby' },
        h('div', { class: 'lb-top' }, h('button', { class: 'btn small', onclick: () => this.onBack() }, `← ${t('Back')}`), h('div', { class: 'lb-title' }, t('MULTIPLAYER'))),
        h(
          'div',
          { class: 'lb-menu' },
          h(
            'div',
            { class: 'lb-card' },
            h('h3', {}, t('Create a room')),
            h('p', {}, t('You host the battle on this device. Share the room code with friends.')),
            h('button', { class: 'btn primary', onclick: () => void this.create() }, t('CREATE ROOM')),
          ),
          h(
            'div',
            { class: 'lb-card' },
            h('h3', {}, t('Join a room')),
            h('p', {}, t('Enter the 5-letter room code from the host.')),
            h('div', { class: 'lb-joinrow' }, code, h('button', { class: 'btn primary', onclick: () => void this.join(code.value) }, t('JOIN'))),
          ),
        ),
        h('div', { class: 'lb-namerow' }, h('span', { class: 'label' }, t('Player name')), name, h('span', { class: 'lb-lineup' }, `${t('Lineup')}: ${s.lineup.map((id) => getVehicle(id).name).join(' · ')}`)),
        h('div', { class: 'lb-note' }, t('Up to 5 vs 5 players — empty places are filled with AI tanks. Same Wi-Fi connects best.')),
        err ? h('div', { class: 'lb-err' }, err) : null,
      ),
    );
  }

  private renderBusy(text: string, cancel: () => void) {
    this.el.innerHTML = '';
    this.el.append(
      h(
        'div',
        { class: 'lobby lb-busy' },
        h('div', { class: 'lb-spin' }),
        h('div', { class: 'lb-busytext' }, text),
        h('button', { class: 'btn', onclick: () => cancel() }, t('Cancel')),
      ),
    );
  }

  private errText(e: unknown): string {
    const kind = e instanceof NetError ? e.kind : 'error';
    switch (kind) {
      case 'not-found':
        return t('Room not found — check the code.');
      case 'full':
        return t('The room is full.');
      case 'started':
        return t('That battle has already started.');
      case 'version':
        return t('Different game versions — reload the page on both devices.');
      case 'timeout':
      case 'network':
      case 'server-error':
      case 'socket-error':
      case 'socket-closed':
        return t('Could not reach the matchmaking server. Check the connection and try again.');
      case 'browser-incompatible':
        return t('This browser does not support multiplayer (WebRTC).');
      default:
        return `${t('Connection failed')} (${kind})`;
    }
  }

  async create() {
    const token = ++this.busyToken;
    this.renderBusy(t('Creating room…'), () => {
      this.busyToken++;
      this.renderMenu();
    });
    const s = get();
    try {
      const room = await HostRoom.create(s.playerName, s.lineup, s.settings.map);
      if (token !== this.busyToken) {
        room.close();
        return;
      }
      this.host = room;
      room.onChange = () => !this.inBattle && this.renderRoom();
      room.onPlayerLeft = (n) => toast(`${n} ${t('left')}`);
      this.renderRoom();
    } catch (e) {
      if (token === this.busyToken) this.renderMenu(this.errText(e));
    }
  }

  async join(raw: string) {
    const code = normCode(raw);
    if (code.length !== 5) {
      this.renderMenu(t('Room codes have 5 letters.'));
      return;
    }
    const token = ++this.busyToken;
    this.renderBusy(`${t('Joining room')} ${code}…`, () => {
      this.busyToken++;
      this.renderMenu();
    });
    const s = get();
    try {
      const room = await ClientRoom.join(code, s.playerName, s.lineup);
      if (token !== this.busyToken) {
        room.leave();
        return;
      }
      this.client = room;
      room.onChange = () => !this.inBattle && this.renderRoom();
      room.onStart = (g) => this.onClientStart(room, g);
      room.onClosed = (why) => this.clientClosed(why);
      this.renderRoom();
    } catch (e) {
      if (token === this.busyToken) this.renderMenu(this.errText(e));
    }
  }

  private clientClosed(why: RejectReason) {
    this.client = null;
    if (this.inBattle) return; // the battle screen reports it
    toast(why === 'closed' ? t('The host closed the room') : t('Connection to the host lost'));
    this.renderMenu();
  }

  leaveRoom() {
    if (this.host) this.host.close();
    if (this.client) this.client.leave();
    this.host = null;
    this.client = null;
  }

  // ------------------------------------------------------------------ room
  private renderRoom() {
    const room = this.host ?? this.client;
    if (!room) return this.renderMenu();
    const isHost = !!this.host;
    const players: LobbyPlayer[] = this.host ? this.host.players : this.client!.players;
    const myKey = this.host ? 'host' : this.client!.key;
    const me = players.find((p) => p.key === myKey);
    const mapId = this.host ? this.host.mapId : this.client!.mapId;
    const code = room.code;

    const team = (tm: 0 | 1) => {
      const list = players.filter((p) => p.team === tm);
      const box = h('div', { class: `lb-team ${tm === 0 ? 'a' : 'b'}` }, h('h3', {}, `${tm === 0 ? t('Team A') : t('Team B')}  ${list.length}/${TEAM_MAX}`));
      for (const p of list) {
        const lead = getVehicle(p.lineup[0]);
        const row = h(
          'div',
          { class: `lb-p${p.key === myKey ? ' me' : ''}` },
          h('b', {}, `${p.host ? '★ ' : ''}${p.name}`),
          h('span', {}, p.lineup.map((id) => getVehicle(id).name).join(' · ')),
          h('i', {}, `BR ${lead.br.toFixed(1)}`),
        );
        if (isHost && p.key !== 'host') {
          row.append(h('button', { class: 'btn small', onclick: () => this.host!.setTeam(p.key, tm === 0 ? 1 : 0) }, '⇄'));
        }
        box.append(row);
      }
      const ai = TEAM_MAX - list.length;
      if (ai > 0) box.append(h('div', { class: 'lb-p ai' }, h('b', {}, `+ ${ai} AI`)));
      return box;
    };

    const maps: Array<[string, string]> = [['random', t('Random')], ...MAPS.map((m) => [m.id, t(m.name)] as [string, string])];
    const mapEl = isHost
      ? h('div', { class: 'map-pick lb-maps' }, ...maps.map(([id, name]) => h('button', { class: id === mapId ? 'on' : '', onclick: () => this.host!.setMap(id) }, name)))
      : h('div', { class: 'lb-mapname' }, `${t('Map')}: ${maps.find((m) => m[0] === mapId)?.[1] ?? '—'}`);

    const switchTeam = () => {
      if (!me) return;
      const to: 0 | 1 = me.team === 0 ? 1 : 0;
      if (players.filter((p) => p.team === to).length >= TEAM_MAX) return toast(t('That team is full'));
      if (this.host) this.host.setTeam('host', to);
      else this.client!.setTeam(to);
    };

    this.el.innerHTML = '';
    this.el.append(
      h(
        'div',
        { class: 'lobby' },
        h(
          'div',
          { class: 'lb-top' },
          h('button', { class: 'btn small', onclick: () => this.confirmLeave() }, `← ${t('Leave')}`),
          h('div', { class: 'lb-title' }, t('MULTIPLAYER')),
          h('div', { class: 'lb-code' }, h('span', {}, t('ROOM')), h('b', {}, code), h('button', { class: 'btn small', onclick: () => void this.share(code) }, t('Invite'))),
        ),
        h('div', { class: 'lb-teams' }, team(0), team(1)),
        h(
          'div',
          { class: 'lb-bottom' },
          h('div', { class: 'lb-col' }, h('div', { class: 'label' }, t('Map')), mapEl),
          h('div', { class: 'lb-col lb-mine' }, h('button', { class: 'btn', onclick: () => switchTeam() }, t('Switch team')), h('button', { class: 'btn', onclick: () => this.editLineup() }, `${t('Lineup')} ✎`)),
          isHost
            ? h('button', { class: 'btn primary lb-start', onclick: () => this.host && this.onHostStart(this.host) }, t('START BATTLE'))
            : h('div', { class: 'lb-wait' }, t('Waiting for the host to start…')),
        ),
        h('div', { class: 'lb-note' }, isHost ? t('Your device runs the battle — keep the game open until it ends.') : t('Empty places are filled with AI tanks.')),
      ),
    );
  }

  private confirmLeave() {
    const leave = () => {
      this.leaveRoom();
      this.renderMenu();
    };
    if (this.host && this.host.players.length > 1) {
      let close = () => {};
      const c = h(
        'div',
        {},
        h('h2', {}, t('Close the room?')),
        h('div', { style: 'color:var(--dim);font-size:15px' }, t('Everyone in the room will be disconnected.')),
        h('div', { class: 'row' }, h('button', { class: 'btn danger', onclick: () => (close(), leave()) }, t('Close room')), h('button', { class: 'btn', onclick: () => close() }, t('Back'))),
      );
      close = modal(c);
    } else leave();
  }

  private async share(code: string) {
    const url = `${location.origin}${location.pathname}?room=${code}`;
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    try {
      if (nav.share) {
        await nav.share({ title: 'PENETRATION', text: `${t('Join my tank battle — room')} ${code}`, url });
        return;
      }
    } catch {
      /* cancelled → fall back to copying */
    }
    try {
      await navigator.clipboard.writeText(url);
      toast(t('Invite link copied'));
    } catch {
      toast(url);
    }
  }

  private editLineup() {
    const s = get();
    const sel = [...s.lineup];
    let close = () => {};
    const grid = h('div', { class: 'lb-pick' });
    const draw = () => {
      grid.innerHTML = '';
      for (const id of s.owned) {
        const v = getVehicle(id);
        const i = sel.indexOf(id);
        grid.append(
          h('button', {
            class: i >= 0 ? 'on' : '',
            onclick: () => {
              if (i >= 0) {
                if (sel.length > 1) sel.splice(i, 1);
              } else if (sel.length < 3) sel.push(id);
              else toast(t('Lineup is full (3)'));
              draw();
            },
          }, i >= 0 ? `${i + 1}. ${v.name}` : v.name, h('i', {}, `BR ${v.br.toFixed(1)}`)),
        );
      }
    };
    draw();
    const c = h(
      'div',
      {},
      h('h2', {}, t('Lineup')),
      h('div', { style: 'color:var(--dim);font-size:13px' }, t('Pick up to 3 vehicles. The first one starts the battle.')),
      grid,
      h(
        'div',
        { class: 'row' },
        h('button', {
          class: 'btn primary',
          style: 'font-size:16px',
          onclick: () => {
            s.lineup = [...sel];
            if (!s.lineup.includes(s.selected)) s.selected = s.lineup[0];
            save();
            this.host?.setLineup(sel);
            this.client?.setLineup(sel);
            close();
          },
        }, t('Done')),
        h('button', { class: 'btn', onclick: () => close() }, t('Cancel')),
      ),
    );
    close = modal(c);
  }
}
