/**
 * CentArcDisplay — wraps the existing CentArc + NoteReadout for use as a
 * pluggable tuner style. Default visual.
 */
import React from 'react';
import { View } from 'react-native';
import { CentArc, NoteReadout } from '../../tunerWidgets';
import type { NoteDisplay } from '../../tunerWidgets';

export interface CentArcDisplayProps {
  noteDisplay: NoteDisplay | null;
  freqHz: number | null;
  noteFontSize: number;
  isOutOfRange: boolean;
}

export function CentArcDisplay({ noteDisplay, freqHz, noteFontSize, isOutOfRange }: CentArcDisplayProps) {
  // Own our width so the parent doesn't shrink us to NoteReadout's glyph.
  return (
    <View style={{ width: '100%', maxWidth: 720, alignSelf: 'center' }}>
      <CentArc activeIndex={noteDisplay?.tickIndex ?? null} cents={noteDisplay?.cents ?? null} arcWidth="100%" />
      <NoteReadout
        noteDisplay={noteDisplay}
        freqHz={freqHz}
        noteFontSize={noteFontSize}
        isOutOfRange={isOutOfRange}
      />
    </View>
  );
}
