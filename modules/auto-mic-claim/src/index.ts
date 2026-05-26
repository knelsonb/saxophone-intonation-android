import { EventSubscription, NativeModule, requireNativeModule } from 'expo-modules-core';

import type { CarConnectionState, CallState } from './AutoMicClaim.types';

// ---------------------------------------------------------------------------
// Events map — keys are event names, values are listener signatures.
// The native module sends payloads as { state: string } objects; we unwrap
// them in the listener wrappers below so the public API stays typed.
// ---------------------------------------------------------------------------

type AutoMicClaimEvents = {
  carConnection: (payload: { state: CarConnectionState }) => void;
  callState: (payload: { state: CallState }) => void;
  endCallButton: (payload: Record<string, never>) => void;
};

// Following the pattern from expo-audio/src/AudioModule.types.ts:
// declare a class extending NativeModule so TypeScript treats it as a typed
// instance with addListener<EventName>() inherited from NativeModule/EventEmitter.
declare class NativeAutoMicClaimModule extends NativeModule<AutoMicClaimEvents> {
  getCarConnectionStateAsync(): Promise<CarConnectionState>;
  startTunerCallAsync(): Promise<void>;
  endTunerCallAsync(): Promise<void>;
  getCallStateAsync(): Promise<CallState>;
  hasManageOwnCallsPermissionAsync(): Promise<boolean>;
  requestManageOwnCallsPermissionAsync(): Promise<boolean>;
}

// The native module name must match Name("AutoMicClaim") in AutoMicClaimModule.kt.
const NativeAutoMicClaim = requireNativeModule<NativeAutoMicClaimModule>('AutoMicClaim');

// ---------------------------------------------------------------------------
// Android Auto connection state
// ---------------------------------------------------------------------------

/** Returns the current car-connection state without subscribing. */
export function getCarConnectionStateAsync(): Promise<CarConnectionState> {
  return NativeAutoMicClaim.getCarConnectionStateAsync();
}

/**
 * Subscribes to car-connection changes.
 * Fires with 'connected' when UiModeManager enters UI_MODE_TYPE_CAR,
 * and with 'disconnected' on exit.
 */
export function addCarConnectionListener(
  cb: (state: CarConnectionState) => void
): EventSubscription {
  return NativeAutoMicClaim.addListener('carConnection', (payload) => cb(payload.state));
}

// ---------------------------------------------------------------------------
// Fake call control
// ---------------------------------------------------------------------------

/**
 * Places a fake self-managed incoming call via TelecomManager.addNewIncomingCall.
 * Requires MANAGE_OWN_CALLS permission; will throw if not granted.
 * On success the call transitions to 'active' and the mic is exclusively ours.
 */
export function startTunerCallAsync(): Promise<void> {
  return NativeAutoMicClaim.startTunerCallAsync();
}

/**
 * Hangs up the active fake call.
 * Safe to call when no call is active (no-op on the native side).
 */
export function endTunerCallAsync(): Promise<void> {
  return NativeAutoMicClaim.endTunerCallAsync();
}

/** Returns the current call state without subscribing. */
export function getCallStateAsync(): Promise<CallState> {
  return NativeAutoMicClaim.getCallStateAsync();
}

/** Subscribes to call-state transitions. */
export function addCallStateListener(cb: (state: CallState) => void): EventSubscription {
  return NativeAutoMicClaim.addListener('callState', (payload) => cb(payload.state));
}

/**
 * Subscribes to the car's physical end-call button (KEYCODE_ENDCALL).
 * Telecom routes the key event to TunerConnection.onDisconnect when the call
 * is active, which the module converts into this event.
 * The call state will already be 'ended' when this fires.
 */
export function addEndCallButtonListener(cb: () => void): EventSubscription {
  return NativeAutoMicClaim.addListener('endCallButton', () => cb());
}

// ---------------------------------------------------------------------------
// Permission helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if MANAGE_OWN_CALLS is currently granted.
 * This is a normal (non-dangerous) permission on Android — it is granted at
 * install time on most devices, but some OEM overlays require runtime approval.
 */
export function hasManageOwnCallsPermissionAsync(): Promise<boolean> {
  return NativeAutoMicClaim.hasManageOwnCallsPermissionAsync();
}

/**
 * Requests MANAGE_OWN_CALLS if not already granted.
 * Returns true if the permission is granted after the request.
 */
export function requestManageOwnCallsPermissionAsync(): Promise<boolean> {
  return NativeAutoMicClaim.requestManageOwnCallsPermissionAsync();
}

export type { CarConnectionState, CallState };
