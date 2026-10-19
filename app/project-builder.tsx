"use client";

import { useRef, useState } from "react";

type Track = { id: number; title: string; bpm: number; tags: string[]; duration: string; favorite?: boolean; audioName?: string; listenCount?: number };
type Stats = { up: number; down: number; count: number; score: number };
const pageSize = 20;
const seconds = (value: string) => value.split(":").reduce((sum, part) => sum * 60 + (Number(part) || 0), 0);

export default function ProjectBuilder({ tracks, order, onOrder, onFavorite, onOpen, statsFor, audioUrl, onAudition }: {
  tracks: Track[]; order: number[]; onOrder: (ids: number[]) => void;
  onFavorite: (id: number) => void; onOpen: (id: number) => void;
  statsFor: (id: number) => Stats; audioUrl: (id: number) => string; onAudition: (id: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("");
  const [favorite, setFavorite] = useState(false);
  const [unlistened, setUnlistened] = useState(false);
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [sort, setSort] = useState("rate");
  const [page, setPage] = useState(0);
  const [selection, setSelection] = useState<number[]>([]);
  const [tab, setTab] = useState("candidates");
  const [preview, setPreview] = useState<number>();
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  const audio = useRef<HTMLAudioElement>(null);
  const counted = useRef<number | undefined>(undefined);
  const candidates = tracks.filter((track) => !order.includes(track.id));
  const ordered = order.map((id) => tracks.find((track) => track.id === id)).filter((track): track is Track => Boolean(track));
  const listens = (track: Track) => track.listenCount ?? statsFor(track.id).count;
  const rate = (track: Track) => { const { up, down } = statsFor(track.id); return up + down ? up / (up + down) : -1; };
  const invalid = (min !== "" && Number(min) < 0) || (max !== "" && Number(max) < 0) || (min !== "" && max !== "" && Number(min) > Number(max));
  const filtered = invalid ? [] : candidates.filter((track) => {
    const text = `${track.title} ${track.tags.join(" ")}`.toLocaleLowerCase();
    return query.toLocaleLowerCase().trim().split(/\s+/).every((word) => text.includes(word)) && (!tag || track.tags.includes(tag)) && (!favorite || track.favorite) && (!unlistened || !listens(track)) && (min === "" || track.bpm > 0 && track.bpm >= Number(min)) && (max === "" || track.bpm > 0 && track.bpm <= Number(max));
  }).sort((a, b) => (sort === "rate" ? rate(b) - rate(a) : sort === "votes" ? statsFor(b.id).up - statsFor(a.id).up : sort === "listens" ? listens(a) - listens(b) : sort === "tempo" ? (a.bpm || Infinity) - (b.bpm || Infinity) : 0) || a.title.localeCompare(b.title));
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const visible = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const selected = filtered.filter((track) => selection.includes(track.id));
  const total = ordered.reduce((sum, track) => sum + seconds(track.duration), 0);
  const previewTrack = tracks.find((track) => track.id === preview);
  function add(ids: number[]) { onOrder([...order, ...ids.filter((id) => !order.includes(id))]); setSelection((current) => current.filter((id) => !ids.includes(id))); }
  function move(index: number, offset: number) { const next = ordered.map((track) => track.id); [next[index], next[index + offset]] = [next[index + offset], next[index]]; onOrder(next); }
  return <section className="project-builder" data-mobile-panel={tab} aria-label="Tracklist builder">
    <div className="builder-tabs"><button aria-pressed={tab === "candidates"} onClick={() => setTab("candidates")}>Candidates ({candidates.length})</button><button aria-pressed={tab === "tracklist"} onClick={() => setTab("tracklist")}>Tracklist ({ordered.length})</button></div>
    <section className="builder-candidates" aria-label="Browse candidates">
      <header><h2>Candidates</h2><span role="status">{filtered.length} matching / {candidates.length} available</span></header>
      <div className="builder-filters">
        <label className="builder-search">Search title or tags<input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} /></label>
        <label>Tag<select value={tag} onChange={(event) => { setTag(event.target.value); setPage(0); }}><option value="">All tags</option>{[...new Set(tracks.flatMap((track) => track.tags))].sort().map((name) => <option key={name}>{name}</option>)}</select></label>
        <label>Sort<select value={sort} onChange={(event) => { setSort(event.target.value); setPage(0); }}><option value="rate">Upvote rate</option><option value="votes">Most upvotes</option><option value="listens">Fewest listens</option><option value="tempo">Tempo</option><option value="title">Title</option></select></label>
        <label>Minimum BPM<input type="number" min="0" value={min} onChange={(event) => { setMin(event.target.value); setPage(0); }} /></label>
        <label>Maximum BPM<input type="number" min="0" value={max} onChange={(event) => { setMax(event.target.value); setPage(0); }} /></label>
        <label className="builder-check"><input type="checkbox" checked={favorite} onChange={(event) => { setFavorite(event.target.checked); setPage(0); }} /> Favourites</label>
        <label className="builder-check"><input type="checkbox" checked={unlistened} onChange={(event) => { setUnlistened(event.target.checked); setPage(0); }} /> Unlistened</label>
        <button className="secondary-button" onClick={() => { setQuery(""); setTag(""); setMin(""); setMax(""); setFavorite(false); setUnlistened(false); setPage(0); }}>Clear filters</button>
      </div>
      {invalid && <p role="alert">Use non-negative tempos, with minimum no greater than maximum.</p>}
      <div className="builder-bulk"><label className="builder-check"><input type="checkbox" checked={visible.length > 0 && visible.every((track) => selection.includes(track.id))} onChange={(event) => setSelection(event.target.checked ? [...new Set([...selection, ...visible.map((track) => track.id)])] : selection.filter((id) => !visible.some((track) => track.id === id)))} /> Select page</label><button className="primary-button" disabled={!selected.length} onClick={() => add(selected.map((track) => track.id))}>Add selected ({selected.length})</button><button className="text-button" disabled={!selection.length} onClick={() => setSelection([])}>Clear selection</button></div>
      {previewTrack && <div className="builder-preview"><strong>Audition · {previewTrack.title}</strong><audio key={preview} ref={audio} src={audioUrl(previewTrack.id)} autoPlay onPlay={() => { setPlaying(true); if (counted.current !== preview) { counted.current = preview; onAudition(previewTrack.id); } }} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => { setError("Could not play this audio."); setPlaying(false); }}><track kind="captions" /></audio><button className="secondary-button" onClick={() => { if (playing) audio.current?.pause(); else audio.current?.play().catch(() => setError("Press play again to retry.")); }}>{playing ? "Pause" : "Play"}</button><button className="secondary-button" onClick={() => { audio.current?.pause(); setPreview(undefined); }}>Stop</button>{error && <p role="alert">{error}</p>}</div>}
      <div className="builder-results">{visible.map((track) => { const stats = statsFor(track.id); return <article className="builder-candidate" key={track.id}>
        <label className="builder-check"><input type="checkbox" checked={selection.includes(track.id)} aria-label={`Select ${track.title}`} onChange={(event) => setSelection(event.target.checked ? [...selection, track.id] : selection.filter((id) => id !== track.id))} /></label>
        <div className="builder-track-copy"><button className="text-button" onClick={() => onOpen(track.id)}>{track.title}</button><small>{track.bpm ? `${track.bpm} BPM` : "BPM unknown"} · {track.duration} · {track.tags.join(" · ") || "No tags"}</small><span>↑ {stats.up} · ↓ {stats.down} · {rate(track) < 0 ? "Unrated" : `${Math.round(rate(track) * 100)}% up`} · {listens(track)} listens · Score {stats.score}</span></div>
        <div className="builder-row-actions"><button className={`favorite-button ${track.favorite ? "active" : ""}`} aria-pressed={Boolean(track.favorite)} aria-label={`${track.favorite ? "Unfavourite" : "Favourite"} ${track.title}`} onClick={() => onFavorite(track.id)}>{track.favorite ? "★" : "☆"}</button><button className="secondary-button" disabled={!track.audioName} onClick={() => { audio.current?.pause(); counted.current = undefined; setError(""); if (preview === track.id) audio.current?.play().catch(() => setError("Could not play this audio.")); else setPreview(track.id); }}>Audition</button><button className="primary-button" aria-label={`Add ${track.title} to tracklist`} onClick={() => add([track.id])}>Add</button></div>
      </article>; })}</div>
      {!filtered.length && <p className="empty-state">{candidates.length ? "No candidates match these filters." : "All project tracks are in this tracklist. Import more demos or remove a track from the list."}</p>}
      <footer className="builder-pagination"><button className="secondary-button" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>Previous page</button><span>Page {currentPage + 1} of {pages}</span><button className="secondary-button" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>Next page</button></footer>
    </section>
    <aside className="builder-order" aria-label="Ordered tracklist"><header><h2>Tracklist</h2><span>{ordered.length} tracks · {Math.floor(total / 60)}m {Math.round(total % 60)}s</span></header><p>Use the arrows to reorder. Removing a track returns it to candidates.</p><ol>{ordered.map((track, index) => <li key={track.id}><button className="text-button" onClick={() => onOpen(track.id)}>{index + 1}. {track.title}</button><small>{track.duration}</small><div><button className="secondary-button" disabled={!index} aria-label={`Move ${track.title} up`} onClick={() => move(index, -1)}>↑</button><button className="secondary-button" disabled={index === ordered.length - 1} aria-label={`Move ${track.title} down`} onClick={() => move(index, 1)}>↓</button><button className="secondary-button" aria-label={`Remove ${track.title} from tracklist`} onClick={() => onOrder(order.filter((id) => id !== track.id))}>Remove</button></div></li>)}</ol>{!ordered.length && <p>Add candidates to begin this tracklist.</p>}</aside>
  </section>;
}
