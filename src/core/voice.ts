// Spoken radio callouts through the browser's speech synthesis (no audio files). Silently does
// nothing where speech synthesis or a voice for the language is missing.

type Lang = 'en' | 'zh';

const synth: SpeechSynthesis | null = typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;
let voices: SpeechSynthesisVoice[] = [];
let unlocked = false;

function loadVoices() {
  if (!synth) return;
  try {
    voices = synth.getVoices();
  } catch {
    voices = [];
  }
}
loadVoices();
synth?.addEventListener?.('voiceschanged', loadVoices);

function pickVoice(lang: Lang): SpeechSynthesisVoice | null {
  if (!voices.length) loadVoices();
  const norm = (v: SpeechSynthesisVoice) => v.lang.toLowerCase().replace('_', '-');
  if (lang === 'zh') {
    for (const want of ['zh-tw', 'zh-hk', 'cmn-hant', 'zh-hant', 'zh-cn', 'zh']) {
      const v = voices.find((x) => norm(x).startsWith(want));
      if (v) return v;
    }
    return null;
  }
  return voices.find((x) => norm(x).startsWith('en-us')) ?? voices.find((x) => norm(x).startsWith('en')) ?? null;
}

export const voice = {
  enabled: true,
  volume: 0.8,
  /** what was said last (tests / debugging) */
  last: '' as string,

  available(): boolean {
    return !!synth;
  },

  /** iOS only lets a page speak after it spoke once inside a touch handler: say nothing, quietly. */
  unlock() {
    if (!synth || unlocked) return;
    unlocked = true;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      synth.speak(u);
    } catch {
      /* ignore */
    }
  },

  say(text: string, lang: Lang, pitch = 0.9) {
    this.last = text;
    if (!synth || !this.enabled || this.volume <= 0) return;
    const v = pickVoice(lang);
    if (!v && lang === 'zh') return; // an English voice reading Chinese is worse than silence
    try {
      // radio chatter should not pile up: keep at most the line being spoken and this one
      if (synth.pending) synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      if (v) u.voice = v;
      u.lang = v?.lang ?? (lang === 'zh' ? 'zh-TW' : 'en-US');
      u.rate = 1.12;
      u.pitch = pitch;
      u.volume = Math.min(1, this.volume * 1.1);
      synth.speak(u);
    } catch {
      /* speech not allowed right now */
    }
  },

  stop() {
    try {
      synth?.cancel();
    } catch {
      /* ignore */
    }
  },
};
