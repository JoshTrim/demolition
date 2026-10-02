"use client";

import { useState } from "react";

type Track = { id: number; title: string; bpm: number; tags: string[]; project: string; status: string; note: string; favorite?: boolean; listenCount?: number; audioName?: string };
type Stats = { up: number; down: number; count: number };
const dimensions = ["Tempo", "Upvotes", "Downvotes", "Listens", "Upvote %"] as const;
type Dimension = typeof dimensions[number];

export default function DemoSearch<T extends Track>({ demos, statsFor, query, setQuery, onOpen, onListen }: { demos: T[]; statsFor: (id: number) => Stats; query: string; setQuery: (query: string) => void; onOpen: (demo: T) => void; onListen: (demos: T[]) => void }) {
  const [ranges, setRanges] = useState<Partial<Record<Dimension, [string, string]>>>({});
  const [tags, setTags] = useState<string[]>([]);
  const [tagMode, setTagMode] = useState("all");
  const [project, setProject] = useState("");
  const [status, setStatus] = useState("");
  const [favorite, setFavorite] = useState(false);
  const [sort, setSort] = useState("title");
  const [limit, setLimit] = useState(50);
  const allTags = [...new Set(demos.flatMap((demo) => demo.tags))].sort((a, b) => a.localeCompare(b));
  const invalid = dimensions.filter((key) => { const [min = "", max = ""] = ranges[key] || []; return (min !== "" && max !== "" && Number(min) > Number(max)) || [min, max].some((value) => value !== "" && (!Number.isFinite(Number(value)) || Number(value) < 0 || (key === "Upvote %" && Number(value) > 100))); });
  function values(demo: T) { const stats = statsFor(demo.id); return { Tempo: demo.bpm || undefined, Upvotes: stats.up, Downvotes: stats.down, Listens: demo.listenCount ?? stats.count, "Upvote %": stats.up + stats.down ? stats.up / (stats.up + stats.down) * 100 : undefined }; }
  const results = invalid.length ? [] : demos.filter((demo) => {
    const text = `${demo.title} ${demo.note} ${demo.tags.join(" ")}`.toLocaleLowerCase();
    if (!query.trim().toLocaleLowerCase().split(/\s+/).every((word) => text.includes(word))) return false;
    if (project && demo.project !== project || status && demo.status !== status || favorite && !demo.favorite) return false;
    if (tags.length && !(tagMode === "all" ? tags.every((tag) => demo.tags.includes(tag)) : tags.some((tag) => demo.tags.includes(tag)))) return false;
    const metrics = values(demo);
    return dimensions.every((key) => { const [min = "", max = ""] = ranges[key] || []; const value = metrics[key]; return min === "" && max === "" || value !== undefined && (min === "" || value >= Number(min)) && (max === "" || value <= Number(max)); });
  }).sort((a, b) => {
    const av = values(a), bv = values(b);
    const difference = sort === "up" ? bv.Upvotes - av.Upvotes : sort === "rate" ? (bv["Upvote %"] ?? -1) - (av["Upvote %"] ?? -1) : sort === "most" ? bv.Listens - av.Listens : sort === "least" ? av.Listens - bv.Listens : sort === "tempo" ? (av.Tempo ?? Infinity) - (bv.Tempo ?? Infinity) : 0;
    return difference || a.title.localeCompare(b.title);
  });
  const playable = results.filter((demo) => demo.audioName);
  return <section className="demo-search" aria-label="Advanced demo search">
    <div className="search-controls">
      <label>Title, tags or notes<input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setLimit(50); }} placeholder="Search your demos" /></label>
      <div className="search-range-grid">{dimensions.map((key) => <fieldset key={key}><legend>{key}{key === "Tempo" ? " (BPM)" : ""}</legend><div>{[0, 1].map((index) => <label key={index}>{index ? "Maximum" : "Minimum"}<input type="number" min="0" max={key === "Upvote %" ? 100 : undefined} step={key === "Tempo" || key === "Upvote %" ? "any" : "1"} aria-label={`${key} ${index ? "maximum" : "minimum"}`} aria-invalid={invalid.includes(key)} placeholder="Any" value={ranges[key]?.[index] || ""} onChange={(event) => { const pair: [string, string] = [...(ranges[key] || ["", ""])]; pair[index] = event.target.value; setRanges({ ...ranges, [key]: pair }); setLimit(50); }} /></label>)}</div></fieldset>)}</div>
      <div className="search-range-grid"><label>Project<select value={project} onChange={(event) => setProject(event.target.value)}><option value="">All projects</option>{[...new Set(demos.map((demo) => demo.project))].sort().map((name) => <option key={name}>{name}</option>)}</select></label><label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Any status</option>{["unheard", "revisit", "shaping", "finished"].map((name) => <option key={name} value={name}>{name}</option>)}</select></label><label className="search-check"><input type="checkbox" checked={favorite} onChange={(event) => setFavorite(event.target.checked)} /> Favourites only</label></div>
      <fieldset><legend>Tags</legend><label>Match<select value={tagMode} onChange={(event) => setTagMode(event.target.value)}><option value="all">All selected tags</option><option value="any">Any selected tag</option></select></label><div className="tag-picker">{allTags.map((tag) => <button type="button" key={tag} aria-pressed={tags.includes(tag)} className={tags.includes(tag) ? "selected" : ""} onClick={() => setTags(tags.includes(tag) ? tags.filter((item) => item !== tag) : [...tags, tag])}>{tag}</button>)}</div>{!allTags.length && <p>No tags in the library yet.</p>}</fieldset>
      <p>Ranges are inclusive. Unknown tempos and unrated tracks are excluded when their range is set. Votes include all listeners; listens use recorded playback counts.</p>
      {invalid.length > 0 && <p role="alert">Check {invalid.join(", ")}: use non-negative ranges with minimum ≤ maximum; percentages cannot exceed 100.</p>}
      <button className="secondary-button" onClick={() => { setRanges({}); setTags([]); setTagMode("all"); setProject(""); setStatus(""); setFavorite(false); setQuery(""); setSort("title"); setLimit(50); }}>Clear all filters</button>
    </div>
    <div className="search-results-header"><strong role="status">{results.length} of {demos.length} demos</strong><label>Sort results<select value={sort} onChange={(event) => setSort(event.target.value)}><option value="title">Title · A–Z</option><option value="up">Upvotes · highest</option><option value="rate">Upvote % · highest</option><option value="least">Unlistened first</option><option value="most">Most listened</option><option value="tempo">Tempo · lowest</option></select></label><button className="primary-button" disabled={!playable.length} onClick={() => onListen(playable)}>Listen to {playable.length} matches</button></div>
    <div className="search-results">{results.slice(0, limit).map((demo) => { const metrics = values(demo); return <button className="search-result" key={demo.id} onClick={() => onOpen(demo)}><span><strong>{demo.title}</strong><small>{demo.project} · {demo.tags.join(" · ") || "No tags"}</small></span><span>{demo.bpm || "—"} BPM · ↑{metrics.Upvotes} ↓{metrics.Downvotes} · {metrics.Listens} listens</span><span>Open →</span></button>; })}</div>
    {!results.length && !invalid.length && <p className="empty-state">No demos match. Widen a range or clear your filters.</p>}
    {results.length > limit && <button className="secondary-button" onClick={() => setLimit(limit + 50)}>Show 50 more</button>}
  </section>;
}
