/**
 * Which AudioRecord source is actually in use after the fallback chain resolves.
 * Matches the Android AudioSource constant labels, lowercased.
 */
export type AudioSourceType = 'unprocessed' | 'voice_recognition' | 'mic';

/**
 * A single chunk of float32 PCM audio emitted by the native capture thread.
 *
 * Wire format note: the Expo new-arch bridge delivers Kotlin ByteArray as a
 * JS Uint8Array (NOT a raw ArrayBuffer). Callers must reinterpret the bytes
 * as little-endian Float32 — `new Float32Array(uint8.buffer, uint8.byteOffset,
 * uint8.byteLength / 4)` — because `new Float32Array(uint8)` would copy byte
 * VALUES as floats instead of reinterpreting four bytes as one float.
 */
export interface RawAudioBuffer {
  /** Little-endian Float32 mono PCM, delivered as Uint8Array view. */
  data: Uint8Array;
  /** Negotiated sample rate — may differ from the requested rate. */
  sampleRate: number;
}

/** Returned by useRawAudioInput(). */
export interface RawAudioStreamHandle {
  stream: {
    id: string;
    sampleRate: number;
    activeSource: AudioSourceType;
    start(): Promise<void>;
    stop(): Promise<void>;
    addListener(
      event: 'audioStreamBuffer',
      cb: (b: RawAudioBuffer) => void
    ): { remove(): void };
    /**
     * Subscribe to native-side capture errors (ERROR_DEAD_OBJECT,
     * ERROR_INVALID_OPERATION, etc.). The native module also flips
     * isStreaming via captureStateChange, but the dedicated error event
     * carries the reason string and lets callers transition to a recovery
     * state without scraping captureStateChange.errorReason.
     */
    addErrorListener(
      cb: (reason: string) => void
    ): { remove(): void };
  } | null;
  isStreaming: boolean;
  /**
   * Resolves after the module loads and the capability query returns.
   * null while the async check is in flight on mount.
   */
  capability: {
    supportsUnprocessed: boolean;
    nativeSampleRate: number;
  } | null;
}

export interface RawAudioOptions {
  /** Requested sample rate in Hz. Default 48000. */
  sampleRate?: number;
  /** Chunk size emitted to JS in ms. Default 25. */
  bufferDurationMs?: number;
  /** Preferred audio source. Default 'unprocessed'. */
  preferredSource?: AudioSourceType;
}

/** Device audio capability snapshot. */
export interface AudioCapabilities {
  supportsUnprocessed: boolean;
  nativeSampleRate: number;
}
