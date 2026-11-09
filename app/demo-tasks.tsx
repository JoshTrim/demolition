"use client";
import { useEffect, useState } from "react";
export type Task = { id:string; demo_uuid:string; body:string; source_label:string; done:number };
export default function DemoTasks({demoUuid, demos, request, onOpen}:{demoUuid?:string;demos:{uuid:string;title:string}[];request:(options?:RequestInit)=>Promise<Task[]>;onOpen:(uuid:string)=>void}) {
  const [tasks,setTasks]=useState<Task[]>([]),[error,setError]=useState(""),[body,setBody]=useState(""),[busy,setBusy]=useState(false),[completed,setCompleted]=useState(false);
  useEffect(()=>{let active=true;const refresh=()=>request().then(data=>{if(active)setTasks(data);}).catch(()=>{if(active)setError("Could not load tasks.");});void refresh();window.addEventListener("demolition-tasks",refresh);return()=>{active=false;window.removeEventListener("demolition-tasks",refresh);};
    // The parent supplies an API wrapper; refresh only when the demo changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[demoUuid]);
  async function update(options:RequestInit){setBusy(true);setError("");try{setTasks(await request(options));setBody("");window.dispatchEvent(new Event("demolition-tasks"));}catch(e){setError(e instanceof Error?e.message:"Could not save task.");}finally{setBusy(false);}}
  const scoped=tasks.filter(t=>(!demoUuid||t.demo_uuid===demoUuid)&&demos.some(d=>d.uuid===t.demo_uuid));
  return <section className="track-discussion" aria-label="Demo tasks"><h2>{demoUuid?"Tasks":"Work on next"}</h2><p>{scoped.filter(t=>!t.done).length} open tasks · local to your library</p><label><input type="checkbox" checked={completed} onChange={e=>setCompleted(e.target.checked)}/> Show completed</label>
    <ul>{scoped.filter(t=>completed||!t.done).map(t=><li key={t.id}><label><input type="checkbox" checked={Boolean(t.done)} disabled={busy} onChange={e=>void update({method:"PUT",body:JSON.stringify({id:t.id,done:e.target.checked})})}/><span>{t.body}</span></label>{!demoUuid&&<button className="text-button" onClick={()=>onOpen(t.demo_uuid)}>{demos.find(d=>d.uuid===t.demo_uuid)?.title} →</button>}{t.source_label&&<small>{t.source_label}</small>}</li>)}</ul>
    {!scoped.some(t=>completed||!t.done)&&<p>No {completed?"":"open "}tasks. Create one from a demo’s comments or timed notes.</p>}
    {demoUuid&&<form onSubmit={e=>{e.preventDefault();void update({method:"POST",body:JSON.stringify({demoUuid,body})});}}><label>New task<input value={body} maxLength={5000} onChange={e=>setBody(e.target.value)} required/></label><button className="secondary-button" disabled={busy||!body.trim()}>Add task</button></form>}{error&&<p role="alert">{error}</p>}
  </section>;
}
