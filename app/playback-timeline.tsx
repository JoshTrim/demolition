"use client";
import { useEffect, useRef, useState } from "react";
export type PlaybackNote = {legacy?:boolean;author?:string;id:string; version_id:string; track_id:string;body:string; start_seconds:number;end_seconds:number};
export type Waveform = {peaks:number[];duration:number};
const time=(n:number)=>Math.floor(n/60)+":"+String(Math.floor(n%60)).padStart(2,"0");
export function waveform(buffer:AudioBuffer):Waveform {
  const peaks = Array.from({length:240},()=>0), step=Math.max(1,Math.ceil(buffer.length/240));
  for(let c=0;c<buffer.numberOfChannels;c++){const data=buffer.getChannelData(c);for(let b=0;b<240;b++)for(let i=b*step;i<Math.min(data.length,(b+1)*step);i+=Math.max(1,Math.floor(step/100)))peaks[b]=Math.max(peaks[b],Math.abs(data[i]));}
  const max=Math.max(...peaks);return {peaks:max>0?peaks.map(p=>p/max):peaks,duration:buffer.duration};
}
export default function PlaybackTimeline({lanes,waves,duration,position,onSeek,endpoint,demoUuid,versionId=""}:{
  lanes:{id:string;name:string}[];waves:Record<string,Waveform>;duration:number;position:number;onSeek:(at:number)=>void;endpoint?:string;demoUuid?:string;versionId?:string;
}) {
  const [notes,setNotes]=useState<PlaybackNote[]>([]),[track,setTrack]=useState("master"),[start,setStart]=useState(0),[end,setEnd]=useState(0),[body,setBody]=useState(""),[editing,setEditing]=useState<string>(),[busy,setBusy]=useState(false),[error,setError]=useState(""),[zoom,setZoom]=useState(1),[deleteId,setDeleteId]=useState<string>();
  const drag=useRef<{at:number;track:string;left:number;width:number}|undefined>(undefined);
  const total=Math.max(duration,...Object.values(waves).map(w=>w.duration),1);
  async function request(options?:RequestInit) {const response=await fetch(endpoint!+(options?"":"?demo="+encodeURIComponent(demoUuid!)),options);const data=await response.json();if(!response.ok)throw new Error(data.error||"Could not save note");return data as PlaybackNote[];}
  useEffect(()=>{let active=true;if(endpoint&&demoUuid)request().then(data=>{if(active)setNotes(data);}).catch(()=>{if(active)setError("Could not load timeline notes.");});return()=>{active=false;};
    // Parent builds the endpoint; its string and demo identity define the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[endpoint,demoUuid]);
  const scoped=notes.filter(n=>n.legacy||n.version_id===versionId);
  const visible=scoped.filter(n=>n.track_id===track);
  const valid=Number.isFinite(start)&&Number.isFinite(end)&&start>=0&&end>=start&&end<=total;
  function reset(){setEditing(undefined);setDeleteId(undefined);setBody("");setError("");}
  async function save(){setBusy(true);setError("");try{setNotes(await request({method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:editing,demoUuid,versionId,trackId:track,body,start,end})}));reset();}catch(e){setError(e instanceof Error?e.message:"Save failed");}finally{setBusy(false);}}
  return <section className="playback-timeline" aria-label="Track timeline and notes">
    <header><div><h3>Timeline</h3><p>Drag across a lane to select a section. Notes stay with this version and track.</p></div><label>Zoom<select value={zoom} onChange={e=>setZoom(Number(e.target.value))}><option value={1}>Fit</option><option value={2}>2×</option><option value={4}>4×</option></select></label></header>
    <div className="timeline-scroll"><div style={{minWidth:zoom===1?"100%":zoom*700}}><div className="timeline-ruler"><span>TRACK</span><div>{Array.from({length:5},(_,i)=><span key={i}>{time(total*i/4)}</span>)}</div></div>
      {lanes.map(lane=><div className={`timeline-lane ${track===lane.id?"selected":""}`} key={lane.id}><button className="lane-name" aria-pressed={track===lane.id} title={lane.name} disabled={busy} onClick={()=>{setTrack(lane.id);setError("");}}>{lane.name}<small>{scoped.filter(n=>n.track_id===lane.id).length} notes</small></button>
        <div className="lane-rail" role="group" aria-label={lane.name+" timeline"} onPointerDown={e=>{if(e.button!==0||busy)return;const rect=e.currentTarget.getBoundingClientRect(),at=Math.max(0,Math.min(total,(e.clientX-rect.left)/rect.width*total));e.currentTarget.setPointerCapture(e.pointerId);drag.current={at,track:lane.id,left:rect.left,width:rect.width};setTrack(lane.id);reset();setStart(at);setEnd(at);}} onPointerMove={e=>{const d=drag.current;if(!d)return;const at=Math.max(0,Math.min(total,(e.clientX-d.left)/d.width*total));setStart(Math.min(d.at,at));setEnd(Math.max(d.at,at));}} onPointerUp={()=>{drag.current=undefined;}} onPointerCancel={()=>{drag.current=undefined;}}>
          {waves[lane.id]?<div className="lane-wave" style={{width:Math.min(100,waves[lane.id].duration/total*100)+"%"}} aria-hidden="true">{waves[lane.id].peaks.map((p,i)=><i key={i} style={{height:Math.max(2,p*46)}}/>)}</div>:<span className="lane-placeholder">Waveform not loaded</span>}
          {scoped.filter(n=>n.track_id===lane.id).map(n=><span key={n.id} className="lane-note" title={n.body} style={{left:n.start_seconds/total*100+"%",width:Math.max(.5,(n.end_seconds-n.start_seconds)/total*100)+"%"}}/>)}
          {track===lane.id&&<span className="lane-selection" style={{left:start/total*100+"%",width:Math.max(.3,(end-start)/total*100)+"%"}}/>}<span className="lane-playhead" style={{left:Math.min(100,position/total*100)+"%"}}/>
        </div></div>)}
    </div></div>
    {endpoint&&demoUuid?<div className="timeline-editor"><div className="timeline-range"><label>Track<select value={track} disabled={busy} onChange={e=>{setTrack(e.target.value);setError("");}}>{lanes.map(l=><option value={l.id} key={l.id}>{l.name}</option>)}</select></label><label>From (seconds)<input type="number" min={0} max={total} step=".1" value={Math.round(start*10)/10} disabled={busy} onChange={e=>setStart(Number(e.target.value))}/></label><label>To (seconds)<input type="number" min={start} max={total} step=".1" value={Math.round(end*10)/10} disabled={busy} onChange={e=>setEnd(Number(e.target.value))}/></label><button className="secondary-button" disabled={busy} onClick={()=>{setStart(position);setEnd(position);setError("");}}>Use playhead</button><button className="secondary-button" disabled={!valid} onClick={()=>onSeek(start)}>Go to selection</button></div>
    <form onSubmit={e=>{e.preventDefault();void save();}}><label>{editing?"Edit note":"Note on selected section"}<textarea rows={2} maxLength={5000} value={body} disabled={busy} onChange={e=>setBody(e.target.value)} placeholder="What needs changing here?"/></label><div><button className="primary-button" disabled={busy||!body.trim()||!valid}>{busy?"Saving…":editing?"Save changes":"Add note"}</button>{editing&&<button type="button" className="secondary-button" onClick={reset}>Cancel edit</button>}</div></form>
    <div className="timeline-note-list">{visible.map(n=><article className={position>=n.start_seconds&&position<=n.end_seconds?"active":""} key={n.id}><button className="note-seek" onClick={()=>onSeek(n.start_seconds)}>{time(n.start_seconds)}–{time(n.end_seconds)}</button><p>{n.body}{n.legacy&&<small className="legacy-note-label">Listening note by {n.author} · not version-specific</small>}</p>{!n.legacy&&<div><button className="text-button" disabled={busy} onClick={()=>{setStart(n.start_seconds);setEnd(n.end_seconds);setBody(n.body);setEditing(n.id);setDeleteId(undefined);}}>Edit</button><button className="text-button" disabled={busy} onClick={()=>setDeleteId(n.id)}>Delete</button></div>}{deleteId===n.id&&<div className="note-delete-confirm">Delete this note?<button className="secondary-button" disabled={busy} onClick={async()=>{setBusy(true);try{setNotes(await request({method:"DELETE",headers:{"content-type":"application/json"},body:JSON.stringify({id:n.id,demoUuid})}));reset();}catch{setError("Could not delete note.");}finally{setBusy(false);}}}>Confirm delete</button><button className="secondary-button" onClick={()=>setDeleteId(undefined)}>Cancel</button></div>}</article>)}{!visible.length&&<p>No notes on this track in this version.</p>}</div>{error&&<p role="alert">{error}</p>}</div>:<p>Open a demo to save timeline notes.</p>}
  </section>;
}
