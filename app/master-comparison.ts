export type CompareSide = "A" | "B";

/** Both sources start sample-aligned; switching changes gain, never source or seek. */
export class MasterComparison {
  private buffers: AudioBuffer[] = [];
  private nodes: { source:AudioBufferSourceNode; gain:GainNode }[] = [];
  private offset = 0;
  private startedAt = 0;
  private side:CompareSide = "A";
  private fade = { at:0, from:0, to:0 };
  private generation = 0;
  private disposed = false;
  playing = false;
  constructor(readonly context:AudioContext) {}
  get duration() { return this.buffers.length ? Math.min(...this.buffers.map(buffer => buffer.duration)) : 0; }
  get position() { return Math.min(this.duration, this.offset + (this.playing ? Math.max(0, this.context.currentTime - this.startedAt) : 0)); }
  setBuffers(a:AudioBuffer, b:AudioBuffer) { this.pause(); this.buffers = [a, b]; this.offset = 0; }
  async play() {
    if (this.disposed || !this.duration || this.playing) return;
    const generation = ++this.generation;
    await this.context.resume();
    if (this.disposed || generation !== this.generation) return;
    if (this.offset >= this.duration) this.offset = 0;
    this.start();
  }
  private start() {
    this.startedAt = this.context.currentTime + 0.02;
    const selected = this.side === "A" ? 0 : 1;
    this.fade = { at:this.context.currentTime, from:selected, to:selected };
    this.nodes = this.buffers.map((buffer, index) => {
      const source = this.context.createBufferSource(), gain = this.context.createGain();
      source.buffer = buffer;
      gain.gain.setValueAtTime((this.side === "A" ? 0 : 1) === index ? 1 : 0, this.context.currentTime);
      source.connect(gain); gain.connect(this.context.destination);
      source.start(this.startedAt, this.offset);
      source.stop(this.startedAt + this.duration - this.offset);
      return { source, gain };
    });
    this.playing = true;
  }
  private stopNodes() {
    for (const { source, gain } of this.nodes) { try { source.stop(); } catch { /* Already ended. */ } source.disconnect(); gain.disconnect(); }
    this.nodes = [];
  }
  pause() { this.generation++; this.offset = this.position; this.playing = false; this.stopNodes(); }
  seek(time:number) {
    const wasPlaying = this.playing;
    this.pause(); this.offset = Math.max(0, Math.min(time, this.duration));
    if (wasPlaying && this.offset < this.duration) this.start();
  }
  select(side:CompareSide) {
    this.side = side;
    const now = this.context.currentTime;
    const progress = Math.max(0, Math.min(1, (now - this.fade.at) / 0.005));
    const current = this.fade.from + (this.fade.to - this.fade.from) * progress;
    const target = side === "A" ? 0 : 1;
    this.fade = { at:now, from:current, to:target };
    this.nodes.forEach(({ gain }, index) => {
      // Preserve the level during rapid toggles without cancelAndHoldAtTime,
      // which is unavailable in some browsers. Complementary gains sum to one.
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(index === 1 ? current : 1 - current, now);
      gain.gain.linearRampToValueAtTime((side === "A" ? 0 : 1) === index ? 1 : 0, now + 0.005);
    });
  }
  dispose() { this.disposed = true; this.pause(); this.buffers = []; void this.context.close(); }
}
