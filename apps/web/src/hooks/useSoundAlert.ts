import { useCallback, useEffect, useRef, useState } from 'react';

export const SOUND_SETTINGS_STORAGE_KEY = 'stellar-alerts-sound-settings';

export interface SoundSettings {
  muted: boolean;
  volume: number; // 0-100
}

export interface UseSoundAlertOptions {
  /** Default volume in percent (0-100). */
  defaultVolume?: number;
  /** Default muted state. */
  defaultMuted?: boolean;
  /** Custom AudioContext factory (useful for testing). */
  createAudioContext?: () => AudioContext;
}

const DEFAULT_VOLUME = 70;
const DEFAULT_MUTED = false;

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_VOLUME;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function readStoredSettings(): Partial<SoundSettings> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(SOUND_SETTINGS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const obj = parsed as Record<string, unknown>;
    const result: Partial<SoundSettings> = {};
    if (typeof obj.muted === 'boolean') result.muted = obj.muted;
    if (typeof obj.volume === 'number') result.volume = clampPercent(obj.volume);
    return result;
  } catch {
    return {};
  }
}

function writeStoredSettings(settings: SoundSettings): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SOUND_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage errors (e.g. private mode or quota).
  }
}

export interface UseSoundAlertResult {
  muted: boolean;
  volume: number;
  setMuted: (muted: boolean) => void;
  toggleMuted: () => void;
  setVolume: (volume: number) => void;
  /** Resumes the AudioContext. Call from a user gesture handler. */
  unlockAudio: () => Promise<void>;
  /** Returns true if the AudioContext is running and ready to play. */
  isAudioReady: () => boolean;
  /** Plays the synthesized payment chime. */
  playChime: () => Promise<void>;
  /** Plays the chime if not muted and audio is ready. */
  playAlert: () => Promise<void>;
}

export function useSoundAlert(options: UseSoundAlertOptions = {}): UseSoundAlertResult {
  const {
    defaultVolume = DEFAULT_VOLUME,
    defaultMuted = DEFAULT_MUTED,
    createAudioContext,
  } = options;

  const [settings, setSettings] = useState<SoundSettings>(() => {
    const stored = readStoredSettings();
    return {
      muted: typeof stored.muted === 'boolean' ? stored.muted : defaultMuted,
      volume: typeof stored.volume === 'number' ? stored.volume : clampPercent(defaultVolume),
    };
  });

  const contextRef = useRef<AudioContext | null>(null);
  const settingsRef = useRef(settings);

  useEffect(() => {
    settingsRef.current = settings;
    writeStoredSettings(settings);
  }, [settings]);

  useEffect(() => {
    return () => {
      const ctx = contextRef.current;
      contextRef.current = null;
      if (ctx && ctx.state !== 'closed') {
        void ctx.close().catch(() => undefined);
      }
    };
  }, []);

  const getContext = useCallback((): AudioContext | null => {
    if (contextRef.current) return contextRef.current;
    try {
      if (createAudioContext) {
        contextRef.current = createAudioContext();
      } else if (typeof window !== 'undefined') {
        const Ctx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) return null;
        contextRef.current = new Ctx();
      } else {
        return null;
      }
    } catch {
      return null;
    }
    return contextRef.current;
  }, [createAudioContext]);

  const unlockAudio = useCallback(async (): Promise<void> => {
    const ctx = getContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        // Autoplay policy may block resume until a user gesture occurs.
      }
    }
  }, [getContext]);

  const isAudioReady = useCallback((): boolean => {
    const ctx = contextRef.current;
    return !!ctx && ctx.state === 'running';
  }, []);

  const playChime = useCallback(async (): Promise<void> => {
    const ctx = getContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        return;
      }
    }
    if (ctx.state !== 'running') return;

    const volume = clampPercent(settingsRef.current.volume) / 100;
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    const masterGrain = Math.max(0.0001, volume * 0.25);
    gain.gain.setValueAtTime(0, 0);
    gain.gain.linearRampToValueAtTime(masterGrain, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
    gain.connect(ctx.destination);

    // Two-tone pleasant chime: a5 -> e6.
    const notes = [880, 1318.51];
    notes.forEach((freq, index) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const start = now + index * 0.12;
      osc.frequency.setValueAtTime(freq, start);
      osc.connect(gain);
      osc.start(start);
      osc.stop(start + 0.45);
    });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 650);
    });
  }, [getContext]);

  const playAlert = useCallback(async (): Promise<void> => {
    if (settingsRef.current.muted) return;
    await playChime();
  }, [playChime]);

  const setMuted = useCallback((muted: boolean) => {
    setSettings((prev) => ({ ...prev, muted }));
  }, []);

  const toggleMuted = useCallback(() => {
    setSettings((prev) => ({ ...prev, muted: !prev.muted }));
  }, []);

  const setVolume = useCallback((volume: number) => {
    setSettings((prev) => ({ ...prev, volume: clampPercent(volume) }));
  }, []);

  return {
    muted: settings.muted,
    volume: settings.volume,
    setMuted,
    toggleMuted,
    setVolume,
    unlockAudio,
    isAudioReady,
    playChime,
    playAlert,
  };
}
