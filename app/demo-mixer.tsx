"use client";
import { useEffect, useRef, useState } from "react";
import { playableFile } from "./set-files";
import { startStem, stemLevel } from "./stem-playback";

type Stem = { id: string; name: string; kind: string };
const clock = (s: number) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
export default function DemoMixer({ files, master, stemUrl }: { files: Stem[]; master?: string; stemUrl: (id: string) => string }) {
  const stems = files.filter((f) => f.kind === "stem" && playableFile(f.name));
  const [mode, setMode] = useState<"master" | "stems">("master");
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pos, setPos] = useState(0);
  const [length, setLength] = useState(0);
  const [error, setError] = useState("");
  const [solo, setSolo] = useState<string[]>([]), [mute, setMute] = useState<string[]>([]);
  const masterRef = useRef<HTMLAudioElement>(null);
  const ctx = useRef<AudioContext | null>(null);
  const cache = useRef(new Map<string, AudioBuffer>());
  const nodes = useRef(new Map<string, { source: AudioBufferSourceNode; gain: GainNode }>());
  const startTime = useRef(0), offset = useRef(0), generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  function halt() {
    generation.current++; request.current?.abort();
    for (const { source, gain } of nodes.current.values()) { source.stop(); source.disconnect(); gain.disconnect(); }
    nodes.current.clear(); masterRef.current?.pause();
  }
  useEffect(() => { mounted.current = true; const buffers = cache.current; return () => { mounted.current = false; halt(); buffers.clear(); if (ctx.current) void ctx.current.close(); ctx.current = null; }; }, []);
  useEffect(() => { const context = ctx.current; if (context) for (const [id, { gain }] of nodes.current) gain.gain.setTargetAtTime(stemLevel(id, solo, mute), context.currentTime, 0.008); }, [solo, mute]);
  useEffect(() => {
    function otherPlayback(event: Event) {
      if (event.target === masterRef.current || mode !== "stems" || (!playing && !loading)) return;
      if (playing && ctx.current) setPos(Math.max(0, ctx.current.currentTime - startTime.current));
      halt(); setPlaying(false); setLoading(false);
    }
    document.addEventListener("play", otherPlayback, true);
    return () => document.removeEventListener("play", otherPlayback, true);
  }, [mode, playing, loading]);
  useEffect(() => {
    if (!playing || mode !== "stems") return;
    const timer = setInterval(() => { const time = Math.min(length, Math.max(offset.current, (ctx.current?.currentTime ?? 0) - startTime.current)); setPos(time); if (time >= length) { halt(); setPlaying(false); } }, 80);
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
        }
        const duration = Math.max(...stems.map((s) => cache.current.get(s.id)!.duration));
        const at = from >= duration ? 0 : from;
        const when = context.currentTime + 0.05;
        for (const stem of stems) {
          const buffer = cache.current.get(stem.id)!;
          const node = startStem(context, buffer, when, at, stemLevel(stem.id, solo, mute));
          if (node) nodes.current.set(stem.id, node);
        }
        startTime.current = when - at; offset.current = at; setLength(duration); setPos(at);
      }
      setPlaying(true);
    } catch (e) { if (mounted.current && token === generation.current) { halt(); setPlaying(false); setError(e instanceof Error ? e.message : "Playback failed."); } }
    finally { if (mounted.current && token === generation.current) setLoading(false); else if (mounted.current && controller.signal.aborted && request.current === controller) setLoading(false); }
  }
  function switchMode(next: "master" | "stems") {
    if (mode === next) return;
    const time = pause(); setMode(next); setError(""); setLength(next === "master" && Number.isFinite(masterRef.current?.duration) ? masterRef.current!.duration : 0);
    if (playing) void play(next, time);
  }
  return <section className="detail-section" aria-label="Master and stem playback"><h3>Demo playback</h3>
    <div className="heading-actions"><button className="secondary-button" aria-pressed={mode === "master"} onClick={() => switchMode("master")}>Master</button><button className="secondary-button" aria-pressed={mode === "stems"} disabled={!stems.length} onClick={() => switchMode("stems")}>Stems ({stems.length})</button></div>
    <audio ref={masterRef} src={master} preload="metadata" onPause={() => { if (mode === "master") setPlaying(false); }} onTimeUpdate={(e) => { if (mode === "master") setPos(e.currentTarget.currentTime); }} onLoadedMetadata={(e) => { if (mode === "master" && Number.isFinite(e.currentTarget.duration)) setLength(e.currentTarget.duration); }} onEnded={() => setPlaying(false)}><track kind="captions" /></audio>
    <button className="primary-button" disabled={mode === "master" ? !master : !stems.length} onClick={() => playing || loading ? pause() : void play()}>{loading ? "Cancel loading" : playing ? "Pause" : "Play"}</button> <span>{clock(pos)} / {clock(length)}</span>
    <label>Position<input type="range" min="0" max={length || 0} step="0.1" value={Math.min(pos, length)} disabled={!length || loading} onChange={(e) => { const at = Number(e.target.value); if (playing) void play(mode, at); else { setPos(at); if (mode === "master" && masterRef.current) masterRef.current.currentTime = at; } }} /></label>
    {mode === "stems" && stems.map((s) => <div className="detail-section" key={s.id}><strong>{s.name}</strong> <button disabled={loading} className="secondary-button" aria-pressed={solo.includes(s.id)} onClick={() => setSolo(solo.includes(s.id) ? solo.filter((id) => id !== s.id) : [...solo, s.id])}>{solo.includes(s.id) ? "Solo on" : "Solo"}</button> <button disabled={loading} className="secondary-button" aria-pressed={mute.includes(s.id)} onClick={() => setMute(mute.includes(s.id) ? mute.filter((id) => id !== s.id) : [...mute, s.id])}>{mute.includes(s.id) ? "Muted" : "Mute"}</button></div>)}
    {error && <p role="alert">{error}</p>}
  </section>;
}
