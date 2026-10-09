// Vibration feedback. Android browsers have the Vibration API (it starts working after the
// first tap on the page). iPhones expose no vibration to web pages; on iOS 17.4–26.4 a hidden
// switch control ticks the Taptic Engine when it is toggled during a tap, which is all we can do
// there — so only feedback for the player's own taps (firing, buttons) reaches an iPhone.

type Pattern = number | number[];

const IOS = typeof navigator !== 'undefined' && (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

class Haptics {
  enabled = true;
  /** test hook: every pattern that was played */
  log: Array<{ p: Pattern; why: string }> | null = null;
  private busyUntil = 0;
  private busyPrio = 0;
  private iosLabel: HTMLLabelElement | null = null;

  get supported(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  }

  /**
   * Play a pattern (ms on / off / on …). A stronger pattern still running is not cut short by a
   * weaker one. `tap` marks calls made from inside a touch handler (the iPhone fallback needs it).
   */
  pulse(p: Pattern, prio = 1, why = '', tap = false) {
    if (!this.enabled) return;
    const now = performance.now();
    if (now < this.busyUntil && prio < this.busyPrio) return;
    const total = typeof p === 'number' ? p : p.reduce((a, b) => a + b, 0);
    this.busyUntil = now + total;
    this.busyPrio = prio;
    this.log?.push({ p, why });
    if (this.supported) {
      try {
        navigator.vibrate(p);
      } catch {
        /* blocked */
      }
    } else if (IOS && tap) this.iosTick();
  }

  private iosTick() {
    try {
      if (!this.iosLabel) {
        const label = document.createElement('label');
        label.setAttribute('aria-hidden', 'true');
        label.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden;z-index:-1';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.setAttribute('switch', '');
        input.tabIndex = -1;
        label.append(input);
        document.body.append(label);
        this.iosLabel = label;
      }
      this.iosLabel.click();
    } catch {
      /* not available */
    }
  }

  stop() {
    this.busyUntil = 0;
    if (this.supported) {
      try {
        navigator.vibrate(0);
      } catch {
        /* ignore */
      }
    }
  }

  // ------------------------------------------------------------------ game moments
  /** our own gun firing — heavier guns kick harder */
  fire(caliber: number) {
    this.pulse(Math.round(14 + caliber / 7), 1, 'fire');
  }
  /** the fire button was released (iPhone: the only moment a tick can be played for a shot) */
  fireTap() {
    if (!this.supported) this.pulse(10, 1, 'firetap', true);
  }
  /** a light tick for a button press */
  tick() {
    this.pulse(8, 0, 'tick', true);
  }
  /** a shell bounced off / failed to get through our armor */
  glance() {
    this.pulse([28, 30, 14], 2, 'glance');
  }
  /** a shell got through: stronger for more damage */
  penetrated(severity: number) {
    const s = Math.max(0, Math.min(1, severity));
    this.pulse([Math.round(55 + 45 * s), 35, Math.round(35 + 40 * s)], 3, 'pen');
  }
  /** our tank is destroyed */
  destroyed() {
    this.pulse([160, 60, 240, 80, 120], 5, 'dead');
  }
  /** we destroyed an enemy */
  kill() {
    this.pulse([30, 55, 30, 55, 70], 4, 'kill');
  }
  /** an explosion near us (power × closeness) */
  blast(k: number) {
    if (k < 0.12) return;
    this.pulse(Math.round(20 + 70 * Math.min(1, k)), 1 + Math.min(1, k), 'blast');
  }
}

export const haptics = new Haptics();
