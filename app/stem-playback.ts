export function stemLevel(id: string, solo: string[], mute: string[]) {
  return mute.includes(id) || (solo.length > 0 && !solo.includes(id)) ? 0 : 1;
}

export function startStem(context: AudioContext, buffer: AudioBuffer, when: number, offset: number, level: number, pan = 0) {
  if (offset >= buffer.duration) return;
  const source = context.createBufferSource(), gain = context.createGain(), panner = context.createStereoPanner();
  source.buffer = buffer;
  gain.gain.setValueAtTime(level, when);
  panner.pan.setValueAtTime(Math.max(-1, Math.min(1, pan)), when);
  source.connect(gain); gain.connect(panner); panner.connect(context.destination);
  source.start(when, offset);
  return { source, gain, panner };
}
