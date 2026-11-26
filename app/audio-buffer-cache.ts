/** Per-player cache: background waveforms and playback share downloads/decodes. */
export class AudioBufferCache {
  private buffers = new Map<string, AudioBuffer>();
  private pending = new Map<string, Promise<AudioBuffer>>();
  get(url:string) { return this.buffers.get(url); }
  load(url:string,context:BaseAudioContext,signal:AbortSignal) {
    const buffer=this.buffers.get(url);if(buffer)return Promise.resolve(buffer);
    const pending=this.pending.get(url);if(pending)return pending;
    const request=(async()=>{
      const response=await fetch(url,{signal});
      if(!response.ok)throw new Error("Could not load audio for waveform or playback.");
      const decoded=await context.decodeAudioData(await response.arrayBuffer());
      signal.throwIfAborted();this.buffers.set(url,decoded);return decoded;
    })();
    this.pending.set(url,request);
    const release=()=>{if(this.pending.get(url)===request)this.pending.delete(url);};
    void request.then(release,release);
    return request;
  }
  clear() { this.buffers.clear(); this.pending.clear(); }
}
