"use client";
import { useEffect, useRef, useState } from "react";
import { MasterComparison, type CompareSide } from "./master-comparison";
export type MasterChoice = { id:string; label:string; url:string };
const clock = (s:number) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");

export default function MasterCompare({ choices, initialB }:{ choices:MasterChoice[]; initialB?:string }) {
  const [a, setA] = useState(choices[0]?.id || "");
  const [b, setB] = useState(initialB && initialB !== choices[0]?.id && choices.some(c => c.id === initialB) ? initialB : choices[1]?.id || "");
  const [side, setSide] = useState<CompareSide>("A");
  const [playing, setPlaying] = useState(false), [position, setPosition] = useState(0), [duration, setDuration] = useState(0);
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [retry, setRetry] = useState(0);
  const engine = useRef<MasterComparison | null>(null), sideRef = useRef(side);
  const aUrl = choices.find(c => c.id === a)?.url, bUrl = choices.find(c => c.id === b)?.url;

  useEffect(() => {
    const controller = new AbortController();
    const comparison = new MasterComparison(new AudioContext());
    engine.current = comparison;
    async function load() {
      try {
        if (!aUrl || !bUrl) throw new Error("Choose two masters to compare.");
        const buffers = await Promise.all([aUrl, bUrl].map(async url => {
          const response = await fetch(url, { signal:controller.signal });
          if (!response.ok) throw new Error("Could not load a master. Retry or choose another version.");
          return comparison.context.decodeAudioData(await response.arrayBuffer());
        }));
        if (controller.signal.aborted) return;
        comparison.setBuffers(buffers[0], buffers[1]); comparison.select(sideRef.current);
        setPosition(0); setDuration(comparison.duration); setLoading(false);
      } catch (cause) {
        if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : "Could not decode these masters."); setLoading(false); }
      }
    }
    void load();
    return () => { controller.abort(); comparison.dispose(); if (engine.current === comparison) engine.current = null; };
  }, [aUrl, bUrl, retry]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const comparison = engine.current;
      if (!comparison?.playing) return;
      setPosition(comparison.position);
      if (comparison.position >= comparison.duration) { comparison.pause(); setPlaying(false); }
    }, 50);
    function otherPlayback(event:Event) {
      if (event instanceof CustomEvent && event.detail === engine.current) return;
      engine.current?.pause(); setPlaying(false);
    }
    document.addEventListener("play", otherPlayback, true);
    document.addEventListener("demolition-mixer-play", otherPlayback);
    return () => { clearInterval(timer); document.removeEventListener("play", otherPlayback, true); document.removeEventListener("demolition-mixer-play", otherPlayback); };
  }, []);

  function switchSide(next:CompareSide) { sideRef.current = next; engine.current?.select(next); setSide(next); }
  function resetPlayback() {
    engine.current?.pause(); setLoading(true); setError(""); setPlaying(false); setDuration(0); setPosition(0);
  }
  async function togglePlayback() {
    const comparison = engine.current;
    if (!comparison) return;
    if (playing) { comparison.pause(); setPosition(comparison.position); setPlaying(false); return; }
    try {
      document.querySelectorAll("audio").forEach(audio => audio.pause());
      document.dispatchEvent(new CustomEvent("demolition-mixer-play", { detail:comparison }));
      await comparison.play();
      if (engine.current === comparison) setPlaying(comparison.playing);
    } catch { setError("Could not start playback. Retry or choose another master."); }
  }

  return <section className="master-compare" aria-label="Compare master versions">
    <header><h3>Compare masters</h3><p>Both masters are preloaded and run on the same clock. Switch A/B without reloading or seeking. Levels are not loudness-matched; comparison ends at the shorter master.</p></header>
    <div className="compare-choices">{(["A", "B"] as const).map(s => <label key={s}>Master {s}<select value={s === "A" ? a : b} onChange={e => { resetPlayback(); (s === "A" ? setA : setB)(e.target.value); setRetry(value => value + 1); }}>{choices.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>)}</div>
    {loading && <p role="status">Preparing both masters for seamless playback…</p>}
    <div className="compare-transport">
      <button className="secondary-button" aria-pressed={side === "A"} onClick={() => switchSide("A")}>A</button>
      <button className="secondary-button" aria-pressed={side === "B"} onClick={() => switchSide("B")}>B</button>
      <button className="primary-button" disabled={loading || !duration || !!error} onClick={() => void togglePlayback()}>{playing ? "Pause" : "Play"}</button>
      <span>{clock(position)} / {clock(duration)} · Listening to {side}</span>
    </div>
    <label>Comparison position<input type="range" min={0} max={duration} step=".1" value={Math.min(position, duration)} disabled={loading || !duration} onChange={e => { engine.current?.seek(Number(e.target.value)); setPosition(Number(e.target.value)); }} /></label>
    {error && <><p role="alert">{error}</p><button className="secondary-button" onClick={() => { resetPlayback(); setRetry(value => value + 1); }}>Retry loading masters</button></>}
  </section>;
}
