export function stemLevel(id: string, solo: string[], mute: string[]) {
  return mute.includes(id) || (solo.length > 0 && !solo.includes(id)) ? 0 : 1;
}

export function startStem(context: AudioContext, buffer: AudioBuffer, when: number, offset: number, level: number) {
  if (offset >= buffer.duration) return;
  const source = context.createBufferSource(), gain = context.createGain();
  source.buffer = buffer;
  gain.gain.setValueAtTime(level, when);
  source.connect(gain); gain.connect(context.destination);
  source.start(when, offset);
  return { source, gain };
}
