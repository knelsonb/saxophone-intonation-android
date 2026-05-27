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
  return (
    <View>
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
