/**
 * Whether an Android Auto (or generic car dock) UI mode is active.
 * 'connected' means UiModeManager reports UI_MODE_TYPE_CAR.
 */
export type CarConnectionState = 'disconnected' | 'connected';

/**
 * Lifecycle of the fake Telecom call used to claim exclusive mic access.
 *
 * inactive  — no call placed
 * pending   — addNewIncomingCall issued, waiting for onCreateIncomingConnection
 * active    — TunerConnection is ACTIVE; mic is ours
 * ended     — connection disconnected (car end-call button or endTunerCallAsync)
 */
export type CallState = 'inactive' | 'pending' | 'active' | 'ended';
