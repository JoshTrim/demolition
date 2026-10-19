"use client";

import { useRef, useState } from "react";

export type TracklistVersion = { id: string; name: string; ids: number[] };
type Track = { id: number; title: string; audioName?: string };

export default function ProjectTracklists({ lists, selected, onSelect, onChange, ids, tracks, audioUrl, onStarted }: {
  lists: TracklistVersion[]; selected: string; onSelect: (id: string) => void;
  onChange: (lists: TracklistVersion[]) => void; ids: number[]; tracks: Track[];
  audioUrl: (id: number) => string;
  onStarted: (id: number) => void;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const [queue, setQueue] = useState<Track[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  const [session, setSession] = useState(0);
  const counted = useRef(new Set<string>());
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const playable = ids.map((id) => tracks.find((track) => track.id === id)).filter((track): track is Track => Boolean(track?.audioName));
  const current = queue[index];
  function nameFor(defaultName: string, excludeId = "") {
    const name = window.prompt("Tracklist name", defaultName)?.trim();
    if (!name) return;
    if (name.length > 100 || name === "Main tracklist" || lists.some((list) => list.name === name && list.id !== excludeId)) {
      window.alert("Choose a unique name of up to 100 characters."); return;
    }
    return name;
  }
  function create(copy: boolean) {
    const name = nameFor(`Tracklist ${lists.length + 2}`);
    if (!name) return;
    const id = crypto.randomUUID();
    onChange([...lists, { id, name, ids: copy ? [...ids] : [] }]);
    onSelect(id);
  }
  function advance(next: number) {
    if (next >= queue.length) { audio.current?.pause(); setPlaying(false); return; }
    setError(""); setIndex(Math.max(0, next));
  }
  return <section className="track-discussion" aria-label="Project tracklists">
    <div className="heading-actions" style={{ flexWrap: "wrap" }}>
      <label>Tracklist <select value={selected} onChange={(event) => onSelect(event.target.value)}><option value="">Main tracklist</option>{lists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}</select></label>
      <button className="secondary-button" onClick={() => create(false)}>New tracklist</button>
      <button className="secondary-button" onClick={() => create(true)}>Duplicate order</button>
      {selected && <><button className="secondary-button" onClick={() => { const name = nameFor(lists.find((list) => list.id === selected)?.name || "", selected); if (name) onChange(lists.map((list) => list.id === selected ? { ...list, name } : list)); }}>Rename</button>
        <button className="remove-copy" onClick={() => { if (window.confirm("Delete this tracklist? The demos and their files will not be deleted.")) { onChange(lists.filter((list) => list.id !== selected)); onSelect(""); } }}>Delete tracklist</button></>}
      <button className="primary-button" disabled={!playable.length} onClick={() => { audio.current?.pause(); setSession((value) => value + 1); counted.current.clear(); setQueue(playable); setIndex(0); setPosition(0); setError(""); setPlaying(true); }}>Play tracklist</button>
    </div>
    <p>{ids.length} tracks · {playable.length} with audio. Playback follows this order; tracks without audio are skipped. Editing the order does not change the current playback queue.</p>
    {current && <div>
      <p aria-live="polite">{index + 1} / {queue.length} · {current.title}</p>
      <audio key={`${session}:${index}`} ref={audio} src={audioUrl(current.id)} autoPlay onLoadedMetadata={(event) => { setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0); setPosition(0); event.currentTarget.play().catch(() => { setPlaying(false); setError("Press Play to start audio."); }); }} onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)} onPlay={() => { setPlaying(true); setError(""); const key = `${session}:${index}`; if (!counted.current.has(key)) { counted.current.add(key); onStarted(current.id); } }} onPause={() => setPlaying(false)} onEnded={() => advance(index + 1)} onError={() => { setPlaying(false); setError("Could not play this track. Try the next track."); }}><track kind="captions" /></audio>
      <label>Playback position <input style={{ width: "100%" }} type="range" min="0" max={duration} step="0.1" value={Math.min(position, duration)} disabled={!duration} onChange={(event) => { if (audio.current) audio.current.currentTime = Number(event.target.value); setPosition(Number(event.target.value)); }} /></label>
      <div className="heading-actions" style={{ flexWrap: "wrap" }}>
        <button className="secondary-button" disabled={!index} onClick={() => advance(index - 1)}>Previous</button>
        <button className="primary-button" onClick={() => { if (playing) audio.current?.pause(); else audio.current?.play().catch(() => setError("Playback could not start. Try again.")); }}>{playing ? "Pause" : "Play"}</button>
        <button className="secondary-button" disabled={index >= queue.length - 1} onClick={() => advance(index + 1)}>Next</button>
        <button className="secondary-button" onClick={() => { audio.current?.pause(); setQueue([]); setPlaying(false); }}>Stop</button>
      </div>
      {error && <p role="alert">{error}</p>}
    </div>}
  </section>;
}
