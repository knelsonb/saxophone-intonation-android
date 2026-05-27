import { useCallback, useEffect, useRef, useState } from 'react';
import { EventSubscription, NativeModule, requireNativeModule } from 'expo-modules-core';

import type {
  AudioCapabilities,
  AudioSourceType,
  RawAudioBuffer,
  RawAudioOptions,
  RawAudioStreamHandle,
} from './RawAudioInput.types';

// ---------------------------------------------------------------------------
// Native module declaration
// ---------------------------------------------------------------------------

type RawAudioInputEvents = {
  // The Expo new-arch bridge delivers Kotlin ByteArray as a JS Uint8Array.
  // See RawAudioBuffer comment for the byte→Float32 unpacking pattern.
  audioStreamBuffer: (payload: { data: Uint8Array; sampleRate: number }) => void;
  captureStateChange: (payload: { isStreaming: boolean; activeSource: string }) => void;
  audioStreamError: (payload: { reason: string }) => void;
};

// Options object passed to the native startCaptureAsync function.
type NativeStartOptions = {
  sampleRate: number;
  bufferDurationMs: number;
  preferredSource: string;
};

declare class NativeRawAudioInputModule extends NativeModule<RawAudioInputEvents> {
  getCapabilitiesAsync(): Promise<{ supportsUnprocessed: boolean; nativeSampleRate: number }>;
  startCaptureAsync(options: NativeStartOptions): Promise<{
    actualSampleRate: number;
    activeSource: string;
  }>;
  stopCaptureAsync(): Promise<void>;
  getActiveSourceAsync(): Promise<string>;
}

const NativeRawAudioInput =
  requireNativeModule<NativeRawAudioInputModule>('RawAudioInput');

// ---------------------------------------------------------------------------
// Imperative capability check (usable outside hooks, e.g. in effects).
// ---------------------------------------------------------------------------

export function getAudioCapabilitiesAsync(): Promise<AudioCapabilities> {
  return NativeRawAudioInput.getCapabilitiesAsync();
}

// ---------------------------------------------------------------------------
// useRawAudioInput hook
// ---------------------------------------------------------------------------

const DEFAULT_SAMPLE_RATE = 48000;
const DEFAULT_BUFFER_DURATION_MS = 25;
const DEFAULT_PREFERRED_SOURCE: AudioSourceType = 'unprocessed';

export function useRawAudioInput(options?: RawAudioOptions): RawAudioStreamHandle {
  const sampleRate = options?.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const bufferDurationMs = options?.bufferDurationMs ?? DEFAULT_BUFFER_DURATION_MS;
  const preferredSource = options?.preferredSource ?? DEFAULT_PREFERRED_SOURCE;

  const [capability, setCapability] = useState<AudioCapabilities | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);

  // These are written by startCaptureAsync and read by the stream handle.
  const actualSampleRateRef = useRef<number>(sampleRate);
  const activeSourceRef = useRef<AudioSourceType>(preferredSource);

  // Stable stream-handle ID. Changes only when startCaptureAsync resolves a new
  // session. We use a counter so it is always a non-empty string.
  const sessionIdRef = useRef<number>(0);
  const [sessionId, setSessionId] = useState<string>('0');

  // Guards against multiple concurrent start calls and stale stop-on-unmount.
  const startedRef = useRef(false);

  // ---------------------------------------------------------------------------
  // Query capabilities on mount.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    NativeRawAudioInput.getCapabilitiesAsync()
      .then((caps) => {
        if (!cancelled) setCapability(caps);
      })
      .catch(() => {
        // Hardware query failed; surface a safe default so callers can still
        // attempt capture — the native fallback chain will handle the reality.
        if (!cancelled) {
          setCapability({ supportsUnprocessed: false, nativeSampleRate: 44100 });
        }
      });
    return () => { cancelled = true; };
  // Run once on mount — options do not affect the capability query.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // captureStateChange listener — keeps isStreaming in sync with native side.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const sub: EventSubscription = NativeRawAudioInput.addListener(
      'captureStateChange',
      (payload) => {
        setIsStreaming(payload.isStreaming);
        if (!payload.isStreaming) {
          startedRef.current = false;
        }
      }
    );
    return () => sub.remove();
  }, []);

  // ---------------------------------------------------------------------------
  // Stream handle — stable reference exposed to callers.
  // start/stop are recreated when sessionId changes so callers re-read the
  // latest actualSampleRate and activeSource after a restart.
  // ---------------------------------------------------------------------------
  const start = useCallback(async (): Promise<void> => {
    if (startedRef.current) return;
    startedRef.current = true;
    try {
      const result = await NativeRawAudioInput.startCaptureAsync({
        sampleRate,
        bufferDurationMs,
        preferredSource,
      });
      actualSampleRateRef.current = result.actualSampleRate;
      activeSourceRef.current = result.activeSource as AudioSourceType;
      sessionIdRef.current += 1;
      setSessionId(String(sessionIdRef.current));
      setIsStreaming(true);
    } catch (err) {
      startedRef.current = false;
      throw err;
    }
  // sampleRate / bufferDurationMs / preferredSource are resolved from the
  // options snapshot captured when the hook renders.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sampleRate, bufferDurationMs, preferredSource]);

  const stop = useCallback(async (): Promise<void> => {
    startedRef.current = false;
    setIsStreaming(false);
    await NativeRawAudioInput.stopCaptureAsync();
  }, []);

  const addListener = useCallback(
    (
      event: 'audioStreamBuffer',
      cb: (b: RawAudioBuffer) => void
    ): { remove(): void } => {
      const sub: EventSubscription = NativeRawAudioInput.addListener(
        event,
        (payload) => {
          cb({ data: payload.data, sampleRate: payload.sampleRate });
        }
      );
      return sub;
    },
    []
  );

  const addErrorListener = useCallback(
    (cb: (reason: string) => void): { remove(): void } => {
      const sub: EventSubscription = NativeRawAudioInput.addListener(
        'audioStreamError',
        (payload) => { cb(payload.reason); }
      );
      return sub;
    },
    []
  );

  const stream: RawAudioStreamHandle['stream'] = {
    id: sessionId,
    get sampleRate() { return actualSampleRateRef.current; },
    get activeSource() { return activeSourceRef.current; },
    start,
    stop,
    addListener,
    addErrorListener,
  };

  return { stream, isStreaming, capability };
}

// Re-export types for external consumers.
export type {
  AudioCapabilities,
  AudioSourceType,
  RawAudioBuffer,
  RawAudioOptions,
  RawAudioStreamHandle,
};
