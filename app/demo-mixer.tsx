"use client";
import { useEffect, useRef, useState } from "react";
import { playableFile } from "./set-files";
import PlaybackTimeline, { waveform, type Waveform } from "./playback-timeline";
import { startStem, stemLevel } from "./stem-playback";

type Stem = { id: string; name: string; kind: string };
const clock = (s: number) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
export default function DemoMixer({ files, master, stemUrl, autoPlay = false, onEnded, onStarted, notesUrl, demoUuid, versionId }: { notesUrl?: string; demoUuid?: string; versionId?: string; files: Stem[]; master?: string; stemUrl: (id: string) => string; autoPlay?: boolean; onEnded?: () => void; onStarted?: () => void }) {
  const stems = files.filter((f) => f.kind === "stem" && playableFile(f.name));
  const [mode, setMode] = useState<"master" | "stems">("master");
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pos, setPos] = useState(0);
  const [length, setLength] = useState(0);
  const [error, setError] = useState("");
  const [solo, setSolo] = useState<string[]>([]), [mute, setMute] = useState<string[]>([]);
  const [levels, setLevels] = useState<Record<string, number>>({});
  const [pans, setPans] = useState<Record<string, number>>({});
  const [waves,setWaves] = useState<Record<string,Waveform>>({});
  const [waveLoading,setWaveLoading] = useState(false);
  const waveRequest=useRef<AbortController | null>(null);
  const masterRef = useRef<HTMLAudioElement>(null);
  const ctx = useRef<AudioContext | null>(null);
  const cache = useRef(new Map<string, AudioBuffer>());
  const nodes = useRef(new Map<string, { source: AudioBufferSourceNode; gain: GainNode; panner: StereoPannerNode }>());
  const startTime = useRef(0), offset = useRef(0), generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const started = useRef(false);
  const endCallback = useRef(onEnded);
  useEffect(() => { endCallback.current = onEnded; }, [onEnded]);
  function halt() {
    generation.current++; request.current?.abort();
    for (const { source, gain, panner } of nodes.current.values()) { source.stop(); source.disconnect(); gain.disconnect(); panner.disconnect(); }
    nodes.current.clear(); masterRef.current?.pause();
  }
  useEffect(() => { mounted.current = true; const buffers = cache.current; return () => { mounted.current = false; waveRequest.current?.abort(); halt(); buffers.clear(); if (ctx.current) void ctx.current.close(); ctx.current = null; }; }, []);
  useEffect(() => { const context = ctx.current; if (context) for (const [id, { gain, panner }] of nodes.current) { gain.gain.setTargetAtTime(stemLevel(id, solo, mute) * (levels[id] ?? 1), context.currentTime, 0.008); panner.pan.setTargetAtTime(pans[id] ?? 0, context.currentTime, 0.008); } }, [solo, mute, levels, pans]);
  useEffect(() => {
    function otherPlayback(event: Event) {
      if ((event as CustomEvent).detail === masterRef.current || event.target === masterRef.current || mode !== "stems" || (!playing && !loading)) return;
      if (playing && ctx.current) setPos(Math.max(0, ctx.current.currentTime - startTime.current));
      halt(); setPlaying(false); setLoading(false);
    }
    document.addEventListener("play", otherPlayback, true);
    document.addEventListener("demolition-mixer-play", otherPlayback);
    return () => { document.removeEventListener("play", otherPlayback, true); document.removeEventListener("demolition-mixer-play", otherPlayback); };
  }, [mode, playing, loading]);
  useEffect(() => {
    if (!playing || mode !== "stems") return;
    const timer = setInterval(() => { const time = Math.min(length, Math.max(offset.current, (ctx.current?.currentTime ?? 0) - startTime.current)); setPos(time); if (time >= length) { halt(); setPlaying(false); endCallback.current?.(); } }, 80);
    return () => clearInterval(timer);
  }, [playing, mode, length]);
  function pause() {
    const time = mode === "master" ? masterRef.current?.currentTime ?? pos : playing && ctx.current ? Math.max(0, ctx.current.currentTime - startTime.current) : pos;
    halt(); setPlaying(false); setLoading(false); setPos(time); return time;
  }
  async function play(nextMode = mode, from = pos) {
    halt(); const token = generation.current;
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setError("");
    try {
      document.querySelectorAll("audio").forEach((el) => el.pause());
      document.dispatchEvent(new CustomEvent("demolition-mixer-play",{detail:masterRef.current}));
      if (nextMode === "master") {
        const player = masterRef.current;
        if (!player || !master) throw new Error("This demo has no master.");
        const duration = Number.isFinite(player.duration) ? player.duration : 0;
        player.currentTime = duration && from >= duration ? 0 : from;
        await player.play();
        if (token !== generation.current) return;
        setLength(Number.isFinite(player.duration) ? player.duration : 0);
      } else {
        if (!stems.length) throw new Error("No playable stems attached.");
        const context = ctx.current ?? new AudioContext(); ctx.current = context; await context.resume();
        // Decode sequentially to limit peak memory, then schedule every buffer on one clock.
        for (const stem of stems) {
          if (token !== generation.current) return;
          if (cache.current.has(stem.id)) continue;
          const response = await fetch(stemUrl(stem.id), { signal: controller.signal });
          if (!response.ok) throw new Error("Could not load " + stem.name);
          let buffer: AudioBuffer;
          try { buffer = await context.decodeAudioData(await response.arrayBuffer()); } catch { throw new Error("Could not decode " + stem.name + ". Use a browser-supported audio format."); }
          if (token !== generation.current) return;
          cache.current.set(stem.id, buffer);
          setWaves(current=>({...current,[stem.id]:waveform(buffer)}));
        }
        const duration = Math.max(...stems.map((s) => cache.current.get(s.id)!.duration));
        const at = from >= duration ? 0 : from;
        const when = context.currentTime + 0.05;
        for (const stem of stems) {
          const buffer = cache.current.get(stem.id)!;
          const node = startStem(context, buffer, when, at, stemLevel(stem.id, solo, mute) * (levels[stem.id] ?? 1), pans[stem.id] ?? 0);
          if (node) nodes.current.set(stem.id, node);
        }
        startTime.current = when - at; offset.current = at; setLength(duration); setPos(at);
      }
      setPlaying(true);
      if (!started.current) { started.current = true; onStarted?.(); }
    } catch (e) { if (mounted.current && token === generation.current) { halt(); setPlaying(false); setError(e instanceof Error ? e.message : "Playback failed."); } }
    finally { if (mounted.current && token === generation.current) setLoading(false); else if (mounted.current && controller.signal.aborted && request.current === controller) setLoading(false); }
  }
  async function loadWaves() {
    const controller=new AbortController(); waveRequest.current=controller; setWaveLoading(true);setError("");
    try {
      const context=ctx.current ?? new AudioContext();ctx.current=context;
      for(const lane of [...(master?[{id:"master",url:master}]:[]),...stems.map(s=>({id:s.id,url:stemUrl(s.id)}))]) {
        if(controller.signal.aborted)return;
        let buffer=cache.current.get(lane.id);
        if(!buffer){const response=await fetch(lane.url,{signal:controller.signal});if(!response.ok)throw new Error("Could not load waveform");buffer=await context.decodeAudioData(await response.arrayBuffer());if(controller.signal.aborted)return;cache.current.set(lane.id,buffer);}
        const result=waveform(buffer);if(mounted.current){setWaves(current=>({...current,[lane.id]:result})); if(mode==="master"&&lane.id==="master")setLength(result.duration);}
      }
    }catch(e){if(mounted.current&&!controller.signal.aborted)setError(e instanceof Error?e.message:"Waveform loading failed");}
    finally{if(mounted.current)setWaveLoading(false);}
  }
  function seek(at:number){ if(playing) void play(mode,at);else {setPos(at);if(mode==="master"&&masterRef.current)masterRef.current.currentTime=at;} }
  function switchMode(next: "master" | "stems") {
    if (mode === next) return;
    const time = pause(); setMode(next); setError(""); setLength(next === "stems" ? Math.max(0,...stems.map(s=>waves[s.id]?.duration || 0)) : Number.isFinite(masterRef.current?.duration) ? masterRef.current!.duration : waves.master?.duration || 0);
    if (playing) void play(next, time);
  }
  return <section data-source={mode} className="detail-section demo-mixer" aria-label="Master and stem playback"><div className="mixer-title"><div><span className="eyebrow">AUDITION</span><h3>Playback & notes</h3></div><span className="mixer-safety">Non-destructive · session mix</span></div>
    <div className="heading-actions"><button className="secondary-button" aria-pressed={mode === "master"} disabled={waveLoading || !master} onClick={() => switchMode("master")}>Master</button><button className="secondary-button" aria-pressed={mode === "stems"} disabled={waveLoading || !stems.length} onClick={() => switchMode("stems")}>Stems ({stems.length})</button></div>
    <audio ref={masterRef} src={master} preload="metadata" onPause={() => { if (mode === "master") setPlaying(false); }} onTimeUpdate={(e) => { if (mode === "master") setPos(e.currentTarget.currentTime); }} onLoadedMetadata={(e) => { if (mode === "master" && Number.isFinite(e.currentTarget.duration)) setLength(e.currentTarget.duration); if (autoPlay && !started.current) void play("master", 0); }} onEnded={() => { setPlaying(false); endCallback.current?.(); }}><track kind="captions" /></audio>
    <div className="mixer-transport"><button className="primary-button" disabled={waveLoading || (mode === "master" ? !master : !stems.length)} onClick={() => playing || loading ? pause() : void play()}>{loading ? "Cancel loading" : playing ? "Pause" : "Play"}</button> <span>{clock(pos)} / {clock(length)}</span></div>
    <label>Position<input type="range" min="0" max={length || 0} step="0.1" value={Math.min(pos, length)} disabled={!length || loading} onChange={(e) => { const at = Number(e.target.value); if (playing) void play(mode, at); else { setPos(at); if (mode === "master" && masterRef.current) masterRef.current.currentTime = at; } }} /></label>
    {mode === "stems" && <div className="stem-console"><div className="mixer-toolbar"><span>CHANNELS <b>{stems.length}</b></span><button className="secondary-button" disabled={loading} onClick={() => { setSolo([]); setMute([]); setLevels({}); setPans({}); }}>Reset mix</button></div><p>Mute / solo · pan · volume. Mix changes are temporary; note ranges are saved.</p><div className="mixer-channels" aria-label="Stem channels">{stems.map((s, index) => { const volume = levels[s.id] ?? 1, pan = pans[s.id] ?? 0; const silent = !stemLevel(s.id, solo, mute); return <section className={`mixer-channel ${silent ? "channel-silent" : ""}`} key={s.id} aria-label={s.name}>
      <span className="channel-number">{String(index + 1).padStart(2, "0")}</span><h4 title={s.name}>{s.name}</h4>
      <div className="channel-switches"><button disabled={loading} aria-label={`Mute ${s.name}`} aria-pressed={mute.includes(s.id)} onClick={() => setMute(mute.includes(s.id) ? mute.filter((id) => id !== s.id) : [...mute, s.id])}>M</button><button disabled={loading} aria-label={`Solo ${s.name}`} aria-pressed={solo.includes(s.id)} onClick={() => setSolo(solo.includes(s.id) ? solo.filter((id) => id !== s.id) : [...solo, s.id])}>S</button></div>
      <label className="channel-pan">Pan <input aria-label={`Pan ${s.name}`} type="range" min="-1" max="1" step="0.01" value={pan} disabled={loading} onChange={(e) => setPans((v) => ({...v, [s.id]: Number(e.target.value)}))} /><output>{pan === 0 ? "Centre" : Math.round(Math.abs(pan) * 100) + (pan < 0 ? "% L" : "% R")}</output></label>
      <label className="channel-fader">Volume<input aria-label={`Volume ${s.name}`} aria-orientation="vertical" type="range" min="0" max="1.5" step="0.01" value={volume} disabled={loading} onChange={(e) => setLevels((v) => ({...v, [s.id]: Number(e.target.value)}))} /><output>{volume === 0 ? "−∞" : (20 * Math.log10(volume)).toFixed(1)} dB</output></label><small>{mute.includes(s.id) ? "Muted" : silent ? "Not soloed" : solo.includes(s.id) ? "Solo" : "Active"}</small>
    </section>; })}</div></div>}
    <div className="timeline-loader"><button className="secondary-button" disabled={waveLoading || loading} onClick={() => void loadWaves()}>{waveLoading ? "Loading waveforms…" : "Load waveforms"}</button><small>Decoded locally. Large sets use additional memory.</small></div>
    <PlaybackTimeline lanes={[{id:"master",name:"Master"},...stems.map(s=>({id:s.id,name:s.name}))]} waves={waves} duration={length} position={pos} onSeek={seek} endpoint={notesUrl} demoUuid={demoUuid} versionId={versionId}/>
    {error && <p role="alert">{error}</p>}
  </section>;
}
