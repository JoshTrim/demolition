"use client";
import { useEffect, useState } from "react";
type Track={id:number;uuid:string;title:string;status:string;note:string;nextAction:string};
type Pick={uuid:string;pickedAt:number;poolSize?:number;remaining?:number};
type Task={demo_uuid:string;body:string;done:number};
export default function ProjectFocus({project,tracks,order,listName,request,onOpen}:{project:string;tracks:Track[];order:number[];listName:string;request:(path:string,options?:RequestInit)=>Promise<unknown>;onOpen:(id:number)=>void}) {
  const [scope,setScope]=useState("project"),[includeFinished,setIncludeFinished]=useState(false),[pick,setPick]=useState<Pick|null>(null),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(""),[tasks,setTasks]=useState<Task[]>([]);
  useEffect(()=>{let active=true;Promise.all([request("/api/project-focus?project="+encodeURIComponent(project)),request("/api/tasks")]).then(([focus,items])=>{if(active){setPick(focus as Pick|null);setTasks(items as Task[]);}}).catch(()=>{if(active)setError("Could not load your saved pick or tasks. Retry by picking a track.");}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};
    // The request wrapper changes identity during parent renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[project]);
  const pool=tracks.filter(t=>(includeFinished||t.status!=="finished")&&(scope==="project"||order.includes(t.id)));
  const selected=tracks.find(t=>t.uuid===pick?.uuid);
  const openTasks=tasks.filter(t=>t.demo_uuid===selected?.uuid&&!t.done);
  async function draw(){setBusy(true);setError("");try{const result=await request("/api/project-focus",{method:"POST",body:JSON.stringify({project,includeFinished,...(scope==="tracklist"?{ids:order}:{})})});setPick(result as Pick);const latest=await request("/api/tasks").catch(()=>undefined);if(latest)setTasks(latest as Task[]);}catch(e){setError(e instanceof Error?e.message:"Could not pick a track. Your previous pick is kept.");}finally{setBusy(false);}}
  return <section className="project-focus" aria-label="Pick a track to work on"><header><div><span className="eyebrow">WORK SESSION</span><h2>Pick a track to work on</h2><p>A random pick without repeats until the eligible pool is covered. Saved for this project.</p></div></header>
    <div className="focus-controls"><label>Choose from<select value={scope} disabled={busy} onChange={e=>setScope(e.target.value)}><option value="project">All project tracks</option><option value="tracklist">Current tracklist — {listName}</option></select></label><label className="focus-check"><input type="checkbox" checked={includeFinished} disabled={busy} onChange={e=>setIncludeFinished(e.target.checked)}/> Include finished tracks</label><span>{pool.length} eligible</span><button className="primary-button" disabled={busy||loading||!pool.length} onClick={()=>void draw()}>{busy?"Picking…":selected?"Pick another":"Pick a track"}</button></div>
    {!pool.length&&<p>{scope==="tracklist"&&!order.length?"This tracklist is empty. Add tracks or choose all project tracks.":"No eligible tracks. Include finished tracks or add demos to this project."}</p>}
    {selected&&<article className="focus-result" aria-live="polite"><div><span className="eyebrow">SELECTED TRACK</span><h3>{selected.title}</h3>{!pool.some(t=>t.id===selected.id)&&<p>This saved pick is outside your current filters.</p>}<p>{selected.nextAction||"No next action set."}</p>{selected.note&&<p className="focus-note">{selected.note}</p>}{openTasks.length>0&&<><h4>Open tasks ({openTasks.length})</h4><ul>{openTasks.slice(0,3).map((t,i)=><li key={i}>{t.body}</li>)}</ul>{openTasks.length>3&&<small>More tasks on the demo page.</small>}</>}</div><button className="primary-button" onClick={()=>onOpen(selected.id)}>Work on this track →</button></article>}
    {loading&&<p role="status">Loading saved pick…</p>}{error&&<p role="alert">{error}</p>}
  </section>;
}
