/**
 * Which AudioRecord source is actually in use after the fallback chain resolves.
 * Matches the Android AudioSource constant labels, lowercased.
 */
export type AudioSourceType = 'unprocessed' | 'voice_recognition' | 'mic';

/**
 * A single chunk of float32 PCM audio emitted by the native capture thread.
 * Shape mirrors expo-audio's AudioStreamBuffer so the onBuffer callback in
 * useAudioEngine does not need to branch on source.
 */
export interface RawAudioBuffer {
  /** Float32 LE mono PCM. */
  data: ArrayBuffer;
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
