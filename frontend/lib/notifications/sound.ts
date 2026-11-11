/**
 * Fail-silent Web Audio ping for in-app toasts (follow-up pass).
 *
 * Runs entirely in the browser through the Web Audio API: no network
 * request, no audio files to download, nothing added to the low-data
 * budget. Every failure path — no AudioContext, autoplay policy, a
 * suspended context, an exotic browser without the constructor — is
 * swallowed inside this module: a toast that cannot beep must still
 * render, and a notification failure must never break the flow that
 * raised it (same rule as the notification store).
 *
 * Device push notifications (sw.js) keep the OS default sound; this
 * ping is only for in-app toasts, which have no OS surface to play one.
 */
import type { NotificationTone } from './types';

type AudioContextCtor = new () => AudioContext;

/** Lazily-created shared context; null when audio is unavailable. */
let ctx: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    if (ctx) {
      // A context created before the first user gesture can be left
      // suspended by autoplay policy; try to wake it, never throw.
      if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
      return ctx;
    }
    const w = window as Window & { webkitAudioContext?: AudioContextCtor };
    const Ctor = window.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    return ctx;
  } catch {
    return null;
  }
}

/**
 * Tone → short beep sequence: [frequencyHz, startOffsetMs, durationMs].
 * Deliberately quiet, short, and distinct: success rises, info is a
 * single blip, warning falls, error falls lower and slower.
 */
const PING: Record<NotificationTone, [number, number, number][]> = {
  success: [
    [880, 0, 90],
    [1175, 110, 120],
  ],
  info: [[660, 0, 140]],
  warning: [
    [520, 0, 110],
    [392, 130, 150],
  ],
  error: [
    [330, 0, 160],
    [262, 180, 200],
  ],
};

/** Peak oscillator gain — audible at phone volume, far from clipping. */
const PEAK_GAIN = 0.06;

/** Play the ping for a tone. Never throws, never rejects. */
export function playToastPing(tone: NotificationTone): void {
  try {
    const audio = getContext();
    // A suspended context cannot sound; skipping is the honest response
    // (browsers require a user gesture before audio may start).
    if (!audio || audio.state !== 'running') return;
    const now = audio.currentTime;
    for (const [frequency, offsetMs, durationMs] of PING[tone]) {
      const start = now + offsetMs / 1000;
      const stop = start + durationMs / 1000;
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, stop);
      osc.connect(gain).connect(audio.destination);
      osc.start(start);
      osc.stop(stop + 0.02);
      // Release nodes after they finish so the context stays clean.
      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
      };
    }
  } catch {
    /* fail silent — audio is decoration, not information */
  }
}
