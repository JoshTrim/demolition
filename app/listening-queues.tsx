"use client";
import { useEffect, useState } from "react";
import { shuffledListenOrder } from "./listen-order";
export type ListeningQueue = { id:string; name:string; uuids:string[]; cursor:number; filters:{ project:string; tag:string; unlistened:boolean } };
type Track = { id:number; uuid:string; title:string; project:string; tags:string[]; audioName?:string };
export function resumeQueue<T extends {uuid:string}>(queue:ListeningQueue, tracks:T[]) {
  const byUuid = new Map(tracks.map(track => [track.uuid,track]));
  return queue.uuids.slice(queue.cursor).flatMap((uuid,index) => { const track = byUuid.get(uuid); return track ? [{track,cursor:queue.cursor+index}] : []; });
}
export default function ListeningQueues({ demos, listens, request, onStart, onQuick, onClose }:{ demos:Track[]; listens:(id:number)=>number; request:<T>(options?:RequestInit)=>Promise<T>; onStart:(queue:ListeningQueue)=>void; onQuick:()=>void; onClose:()=>void }) {
  const [queues,setQueues] = useState<ListeningQueue[]>([]), [loaded,setLoaded] = useState(false), [error,setError] = useState(""), [busy,setBusy] = useState(false);
  const [name,setName] = useState(""), [project,setProject] = useState(""), [tag,setTag] = useState(""), [unlistened,setUnlistened] = useState(false);
  const playable = demos.filter(demo => demo.audioName);
  function matching(filters:ListeningQueue["filters"]) { return playable.filter(demo => (!filters.project || demo.project === filters.project) && (!filters.tag || demo.tags.includes(filters.tag)) && (!filters.unlistened || listens(demo.id) === 0)); }
  const filters = {project,tag,unlistened}, matches = matching(filters);
  useEffect(() => { let active=true; request<ListeningQueue[]>().then(data => { if(active){setQueues(data);setLoaded(true);} }).catch(() => { if(active)setError("Could not load saved queues. Close and reopen to retry."); }); return () => { active=false; };
    // The parent supplies the API URL builder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  async function save(queue:Partial<ListeningQueue>, tracks:Track[], start=false) {
    setBusy(true);setError("");
    try {
      const saved = await request<ListeningQueue>({method:"POST",body:JSON.stringify({...queue,cursor:0,uuids:shuffledListenOrder(tracks,demo=>listens(demo.id)).map(demo=>demo.uuid)})});
      setQueues(current=>[saved,...current.filter(item=>item.id!==saved.id)]);setName("");
      if(start)onStart(saved);
    } catch { setError("Could not save this queue. Please retry."); } finally { setBusy(false); }
  }
  return <div className="modal-backdrop"><section className="modal listening-queues" role="dialog" aria-modal="true" aria-label="Listening queues">
    <button className="modal-close" aria-label="Close dialog" onClick={onClose}>×</button>
    <div className="eyebrow">LISTEN MODE</div><h2>Listening queues</h2><p>Save a shuffled selection and resume at your current track. New imports are included when you reshuffle, not during an existing round.</p>
    <button className="secondary-button" disabled={!playable.length||busy} onClick={onQuick}>Quick listen · shuffle all</button>
    <form onSubmit={event=>{event.preventDefault();void save({name,filters},matches,true);}}>
      <h3>New saved queue</h3><label>Queue name<input value={name} maxLength={100} required onChange={event=>setName(event.target.value)}/></label>
      <div className="modal-fields"><label>Project<select value={project} onChange={event=>setProject(event.target.value)}><option value="">All projects</option>{[...new Set(playable.map(d=>d.project))].sort().map(value=><option key={value}>{value}</option>)}</select></label><label>Tag<select value={tag} onChange={event=>setTag(event.target.value)}><option value="">All tags</option>{[...new Set(playable.flatMap(d=>d.tags))].sort().map(value=><option key={value}>{value}</option>)}</select></label></div>
      <label className="queue-check"><input type="checkbox" checked={unlistened} onChange={event=>setUnlistened(event.target.checked)}/> Unlistened only</label>
      <p role="status">{matches.length} matching demos</p><button className="primary-button" disabled={busy||!loaded||!name.trim()||!matches.length}>Save &amp; listen</button>
    </form>
    <h3>Saved queues</h3>{!loaded&&!error&&<p>Loading queues…</p>}{loaded&&!queues.length&&<p>No saved queues yet.</p>}
    <div className="saved-queue-list">{queues.map(queue=>{const remaining=resumeQueue(queue,playable);return <article key={queue.id}><h4>{queue.name}</h4><p>{queue.cursor} / {queue.uuids.length} passed · {remaining.length} available to resume</p><p>{queue.filters.project||"All projects"} · {queue.filters.tag||"All tags"}{queue.filters.unlistened?" · Unlistened when shuffled":""}</p><div className="heading-actions">
      <button className="primary-button" disabled={busy||!remaining.length} onClick={()=>onStart(queue)}>Resume</button>
      <button className="secondary-button" disabled={busy||!matching(queue.filters).length} onClick={()=>{if(window.confirm("Reshuffle this queue and reset its progress?"))void save(queue,matching(queue.filters));}}>Reshuffle</button>
      <button className="secondary-button" disabled={busy} onClick={async()=>{if(!window.confirm("Delete this saved queue? Your demos are not removed."))return;setBusy(true);try{await request({method:"DELETE",body:JSON.stringify({id:queue.id})});setQueues(current=>current.filter(item=>item.id!==queue.id));}catch{setError("Could not delete queue.");}finally{setBusy(false);}}}>Delete queue</button>
    </div></article>;})}</div>{error&&<p role="alert">{error}</p>}
  </section></div>;
}
