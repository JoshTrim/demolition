"use client";

import { useState, type ReactNode } from "react";

export type TracklistVersion = { id: string; name: string; ids: number[] };
type Track = { id: number; title: string; audioName?: string; duration?: string };
type EditMode = "new" | "copy" | "rename" | "delete";
const seconds = (value = "") => value.split(":").reduce((sum, part) => sum * 60 + (Number(part) || 0), 0);

export default function ProjectTracklists({ lists, mainIds, selected, onSelect, onChange, ids, tracks, renderPlayer, onStarted, renderFeedback }: {
  lists: TracklistVersion[]; mainIds: number[]; selected: string; onSelect: (id: string) => void;
  onChange: (lists: TracklistVersion[]) => void; ids: number[]; tracks: Track[];
  renderPlayer: (id: number, session: number, onEnded: () => void, onStarted: () => void) => ReactNode;
  onStarted: (id: number) => void;
  renderFeedback: (id: number, session: number) => ReactNode;
}) {
  const [activeId, setActiveId] = useState<number>();
  const [session, setSession] = useState(0);
  const [counted, setCounted] = useState(new Set<string>());
  const [mode, setMode] = useState<EditMode>();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const selectedName = lists.find((list) => list.id === selected)?.name ?? "Main tracklist";
  const choices = [{ id: "", name: "Main tracklist", ids: mainIds }, ...lists];
  const playable = ids.map((id) => tracks.find((track) => track.id === id)).filter((track): track is Track => Boolean(track?.audioName));
  const index = Math.max(0, playable.findIndex((track) => track.id === activeId));
  const current = activeId === undefined ? undefined : playable[index];
  if (activeId !== undefined && current?.id !== activeId) setActiveId(current?.id);
  function select(id: string) {
    setActiveId(undefined); setMode(undefined); setError(""); setNotice(""); onSelect(id);
  }
  function begin(next: EditMode) {
    setMode(next); setError(""); setNotice("");
    let suggestion = next === "copy" ? selectedName + " copy" : "Tracklist " + (lists.length + 2);
    let suffix = 2;
    const base = suggestion;
    while (choices.some((list) => list.name.toLowerCase() === suggestion.toLowerCase())) suggestion = base + " " + suffix++;
    setName(next === "rename" ? selectedName : suggestion.slice(0, 100));
  }
  function save() {
    const value = name.trim();
    if (!value || value.length > 100 || choices.some((list) => list.name.toLowerCase() === value.toLowerCase() && (mode !== "rename" || list.id !== selected))) {
      setError("Use a unique name of 1–100 characters."); return;
    }
    if (mode === "rename") {
      onChange(lists.map((list) => list.id === selected ? { ...list, name: value } : list));
    } else {
      if (lists.length >= 100) { setError("This project already has 100 alternative tracklists."); return; }
      const id = crypto.randomUUID();
      onChange([...lists, { id, name: value, ids: mode === "copy" ? [...ids] : [] }]);
      setActiveId(undefined); onSelect(id);
    }
    setMode(undefined); setNotice(mode === "rename" ? "Tracklist renamed." : "Tracklist created.");
  }
  function advance(next: number) {
    if (next >= playable.length) { setActiveId(undefined); return; }
    setActiveId(playable[Math.max(0, next)]?.id);
  }
  function summary(order: number[]) {
    const included = order.map((id) => tracks.find((track) => track.id === id)).filter((track): track is Track => Boolean(track));
    const total = included.reduce((sum, track) => sum + seconds(track.duration), 0);
    return included.length + (included.length === 1 ? " track · " : " tracks · ") + Math.floor(total / 60) + "m " + Math.round(total % 60) + "s";
  }
  return <section className="tracklist-workspace" aria-label="Project tracklists">
    <header className="tracklist-heading"><div><h2>Tracklists</h2><p>Try different selections and orders. Each list uses the same project candidates.</p></div><button className="primary-button" disabled={lists.length >= 100} onClick={() => begin("new")}>＋ New tracklist</button></header>
    <nav className="tracklist-choices" aria-label="Choose a tracklist">
      {choices.map((list) => <button key={list.id} aria-pressed={selected === list.id} onClick={() => select(list.id)}><strong>{list.name}</strong><span>{summary(list.ids)}</span><small>{selected === list.id ? "Editing this list" : "Open tracklist"}</small></button>)}
    </nav>
    <div className="tracklist-active-header"><div><span className="eyebrow">ACTIVE TRACKLIST</span><h3>{selectedName}</h3><p>{summary(ids)}{ids.length > playable.length ? " · " + (ids.length - playable.length) + " without audio" : ""}</p></div>
      <div className="tracklist-actions"><button className="secondary-button" disabled={lists.length >= 100} onClick={() => begin("copy")}>Duplicate</button>{selected && <><button className="secondary-button" onClick={() => begin("rename")}>Rename</button><button className="secondary-button" onClick={() => begin("delete")}>Delete list</button></>}<button className="primary-button" disabled={!playable.length} onClick={() => { setSession((value) => value + 1); setCounted(new Set()); setActiveId(playable[0]?.id); }}>▶ Audition list</button></div>
    </div>
    {mode === "delete" ? <section className="tracklist-editor" aria-label="Confirm tracklist deletion"><h3>Delete “{selectedName}”?</h3><p>Only this tracklist’s selection and order will be removed. Demos, files and other tracklists are kept.</p><div className="tracklist-actions"><button className="secondary-button" onClick={() => setMode(undefined)}>Cancel</button><button className="secondary-button" onClick={() => { onChange(lists.filter((list) => list.id !== selected)); select(""); setNotice("Tracklist deleted. Main tracklist selected."); }}>Confirm delete</button></div></section>
      : mode && <form className="tracklist-editor" onSubmit={(event) => { event.preventDefault(); save(); }}><label>{mode === "rename" ? "Rename tracklist" : mode === "copy" ? "Name the duplicate" : "New tracklist name"}<input maxLength={100} value={name} onChange={(event) => { setName(event.target.value); setError(""); }} aria-invalid={Boolean(error)} aria-describedby={error ? "tracklist-name-error" : undefined} /></label><p>{mode === "copy" ? "Starts with the current selection and order. Changes to either list remain independent." : mode === "new" ? "Starts empty. Add tracks from the shared candidate pool below." : "Only the name changes; the order stays the same."}</p>{error && <p id="tracklist-name-error" role="alert">{error}</p>}<div className="tracklist-actions"><button className="primary-button" type="submit">{mode === "rename" ? "Save name" : "Create tracklist"}</button><button className="secondary-button" type="button" onClick={() => setMode(undefined)}>Cancel</button></div></form>}
    {notice && <p className="tracklist-notice" role="status">{notice}</p>}
    {current && <section className="tracklist-audition" aria-label="Tracklist audition">
      <header><div><span className="eyebrow">NOW PLAYING · {selectedName}</span><h3 aria-live="polite">{index + 1} / {playable.length} · {current.title}</h3></div><div className="tracklist-actions"><button className="secondary-button" disabled={!index} onClick={() => advance(index - 1)}>Previous</button><button className="secondary-button" disabled={index >= playable.length - 1} onClick={() => advance(index + 1)}>Next</button><button className="secondary-button" onClick={() => setActiveId(undefined)}>Stop audition</button></div></header>
      {renderPlayer(current.id, session, () => advance(index + 1), () => { const key = session + ":" + current.id; if (!counted.has(key)) { setCounted(new Set([...counted, key])); onStarted(current.id); } })}
      <details><summary>Comments, votes & notes for this track</summary>{renderFeedback(current.id, session)}</details>
      <p>Playback follows edits to this list and skips missing audio. Switching tracklists stops the audition.</p>
    </section>}
  </section>;
}
