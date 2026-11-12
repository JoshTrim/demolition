"use client";
import { useEffect, useState } from "react";
import { archiveProject, defaultStemVersion, playableFile } from "./set-files";
import DemoMixer from "./demo-mixer";
import MasterCompare from "./master-compare";
type FileRecord = { id:string; name:string; kind:string; size:number; version_id?:string; created_at:number };
type Version = { id:string; label:string; notes:string; created_at:number };
type Props = { uuid:string; master?:string; apiUrl:(path:string)=>string; revision?:number; autoPlay?:boolean; onEnded?:()=>void; onStarted?:()=>void; uploads?:boolean; beforeUpload?:()=>Promise<void> };
async function request<T>(url:string,options?:RequestInit):Promise<T>{const res=await fetch(url,options),data=await res.json();if(!res.ok)throw new Error(data.error||"Request failed");return data;}
export default function DemoFiles({uuid,master,apiUrl,revision,autoPlay,onEnded,onStarted,uploads,beforeUpload}:Props){
  const [files,setFiles]=useState<FileRecord[]>([]),[versions,setVersions]=useState<Version[]>([]),[selection,setSelection]=useState("");
  const [busy,setBusy]=useState(false),[status,setStatus]=useState(""),[loaded,setLoaded]=useState(false),[formOpen,setFormOpen]=useState(false),[compare,setCompare]=useState(false);
  const [newFile,setNewFile]=useState<File>(),[newLabel,setNewLabel]=useState(""),[newNotes,setNewNotes]=useState("");
  const [pending,setPending]=useState<string>();
  const base="/api/demos/"+encodeURIComponent(uuid);
  useEffect(()=>{let active=true;Promise.all([request<FileRecord[]>(apiUrl(base+"/attachments")),request<Version[]>(apiUrl(base+"/file-versions"))]).then(([f,v])=>{if(active){setFiles(f);setVersions(v);setSelection(current=>current&&v.some(version=>version.id===current)?current:defaultStemVersion(f,v));setLoaded(true);}}).catch(e=>{if(active)setStatus(e.message);});return()=>{active=false;};
    // The parent URL builder may change identity on render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[base,revision]);
  const version=versions.find(v=>v.id===selection),group=files.filter(f=>(f.version_id||"")===selection),versionMaster=group.find(f=>f.kind==="master");
  const choices=[...(master?[{id:"current",label:"Current master",url:master}]:[]),...versions.flatMap(v=>{const file=files.find(f=>f.version_id===v.id&&f.kind==="master");return file?[{id:v.id,label:v.label+" · "+file.name,url:apiUrl("/api/attachments/"+file.id+"?play=1")}]:[];})];
  async function refresh(){const [f,v]=await Promise.all([request<FileRecord[]>(apiUrl(base+"/attachments")),request<Version[]>(apiUrl(base+"/file-versions"))]);setFiles(f);setVersions(v);return f;}
  async function create(captureCurrent=true,label="Current master snapshot",notes=""){await beforeUpload?.();const result=await request<{id:string}>(apiUrl(base+"/file-versions"),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({label,notes,captureCurrent})});setSelection(result.id);await refresh();return result.id;}
  async function addVersion(event:React.FormEvent){
    event.preventDefault();if(!newFile||!newLabel.trim())return;
    setBusy(true);setStatus("");
    try {
      if(!playableFile(newFile.name)||!newFile.size)throw new Error("Choose a non-empty audio export.");
      let id=pending;
      if(!id) {
        await beforeUpload?.();
        const created=await request<{id:string}>(apiUrl(base+"/file-versions"),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({label:newLabel.trim(),notes:newNotes,captureCurrent:false})});
        id=created.id;setPending(id);setSelection(id);
      }
      setStatus("Uploading new version. Your current master is unchanged…");
      const existing=await refresh();
      if(!existing.some(f=>f.version_id===id&&f.kind==="master")){
        setFiles(await request<FileRecord[]>(apiUrl(base+"/attachments?kind=master&version="+encodeURIComponent(id)),{method:"POST",headers:{"content-type":"application/octet-stream","x-file-name":encodeURIComponent(newFile.name)},body:newFile}));
      }
      await refresh();setSelection(id);setPending(undefined);setNewFile(undefined);setNewLabel("");setNewNotes("");setFormOpen(false);setCompare(true);
      setStatus("New version saved. The current master has not changed. Use A/B below to compare.");
    }catch(e){setStatus((e instanceof Error?e.message:"Upload failed")+(pending?" The version is saved; retry to finish its master upload.":""));}
    finally{setBusy(false);}
  }
  async function upload(event:React.ChangeEvent<HTMLInputElement>,kind:string){
    const input=event.currentTarget;let incoming=[...input.files||[]];if(!incoming.length)return;setBusy(true);let completed=0;
    try{
      if(kind==="project-folder"){setStatus("Archiving project folder…");incoming=[await archiveProject({name:incoming[0].webkitRelativePath.split("/")[0]||"Project",masters:[],stems:[],project:incoming},false,true)];kind="project";}
      await beforeUpload?.();const id=selection||await create(true,"Related files · "+new Date().toLocaleString());
      for(const file of incoming){setStatus("Uploading "+file.name);setFiles(await request<FileRecord[]>(apiUrl(base+"/attachments?kind="+kind+"&version="+encodeURIComponent(id)),{method:"POST",headers:{"content-type":"application/octet-stream","x-file-name":encodeURIComponent(file.name)},body:file}));completed++;}
      setStatus(completed+" files saved to this version.");
    }catch(e){setStatus(completed+" files saved. "+(e instanceof Error?e.message:"Upload failed"));}finally{setBusy(false);input.value="";}
  }
  return <section className={uploads?"track-discussion demo-attachments":"track-discussion"} id={uploads?"demo-files":undefined} aria-label={uploads?"Demo files and versions":"Audition sources"}>
    <h2>{uploads?"Files & versions":"Playback source"}</h2>
    <div className="version-actions">{uploads&&<button className="primary-button" disabled={busy||!loaded} onClick={()=>setFormOpen(open=>!open)}>{formOpen?"Close new version":"＋ Add version"}</button>}<button className="secondary-button" disabled={busy||choices.length<2} onClick={()=>setCompare(value=>!value)}>{compare?"Hide comparison":"Compare masters A/B"}</button><span>Adding a version never replaces the current master.</span></div>
    {uploads&&formOpen&&<form className="new-version-form" onSubmit={addVersion}><h3>Add a new export</h3><p>Name the version and upload its master. The existing master and all older versions stay unchanged.</p><label>Version name<input maxLength={100} required value={newLabel} disabled={busy||!!pending} onChange={e=>setNewLabel(e.target.value)} placeholder="e.g. Mix 2 — shorter intro"/></label><label>New master audio{newFile&&<small>Selected: {newFile.name}</small>}<input type="file" accept="audio/*,.wav,.aif,.aiff,.mp3,.m4a,.flac,.ogg,.opus,.aac" required={!newFile} disabled={busy||!!pending} onChange={e=>setNewFile(e.target.files?.[0])}/></label><label>What changed?<textarea maxLength={5000} rows={2} value={newNotes} disabled={busy||!!pending} onChange={e=>setNewNotes(e.target.value)}/></label><button className="primary-button" disabled={busy||!newFile||!newLabel.trim()}>{busy?"Saving…":pending?"Retry master upload":"Upload as new version"}</button>{pending&&<button className="secondary-button" type="button" disabled={busy} onClick={()=>{setPending(undefined);setNewFile(undefined);setNewLabel("");setNewNotes("");setFormOpen(false);setStatus("Incomplete version kept. Select it below to finish uploading its master.");}}>Finish later</button>}</form>}
    {compare&&choices.length>=2&&<MasterCompare key={choices.map(c=>c.id).join(":")} choices={choices} initialB={selection||undefined}/>}
    <label>Audition version<select disabled={busy} value={selection} onChange={e=>setSelection(e.target.value)}><option value="">Current master · original / ungrouped files</option>{versions.map(v=><option value={v.id} key={v.id}>{v.label} · {files.some(f=>f.version_id===v.id&&f.kind==="master")?"master":"no master"} · {files.filter(f=>f.version_id===v.id&&f.kind==="stem").length} stems</option>)}</select></label>
    <p className="version-context">{version?<>Saved version: <strong>{version.label}</strong> · {new Date(version.created_at).toLocaleString()}{version.notes&&<span>{version.notes}</span>}</>:"Playing the current master. Choose a saved version above to audition a different export."}</p>
    {loaded&&<div className="demo-mixer-panel"><DemoMixer key={selection} notesUrl={apiUrl("/api/playback-notes")} demoUuid={uuid} versionId={selection} files={group} master={selection?versionMaster?apiUrl("/api/attachments/"+versionMaster.id+"?play=1"):undefined:master} stemUrl={id=>apiUrl("/api/attachments/"+id+"?play=1")} autoPlay={autoPlay} onEnded={onEnded} onStarted={onStarted}/></div>}
    {uploads&&<details className="version-metadata"><summary>{version?"Rename or edit this version":"Save a snapshot of the current master"}</summary>{version?<form key={version.id} onSubmit={async e=>{e.preventDefault();const form=new FormData(e.currentTarget);setBusy(true);try{setVersions(await request<Version[]>(apiUrl(base+"/file-versions"),{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({id:version.id,label:form.get("label"),notes:form.get("notes")})}));setStatus("Version details saved.");}catch(e){setStatus(e instanceof Error?e.message:"Save failed");}finally{setBusy(false);}}}><label>Version name<input name="label" defaultValue={version.label} required maxLength={100}/></label><label>Version notes<textarea name="notes" defaultValue={version.notes} maxLength={5000}/></label><button className="secondary-button" disabled={busy}>Save details</button></form>:<><p>This copies the current master into a named snapshot. To upload a different export, use Add version.</p><button className="secondary-button" disabled={busy||!master} onClick={async()=>{setBusy(true);try{await create(true,"Current master · "+new Date().toLocaleString());setStatus("Snapshot saved. Current master unchanged.");}catch(e){setStatus(e instanceof Error?e.message:"Could not save snapshot");}finally{setBusy(false);}}}>Save current master snapshot</button></>}</details>}
    {uploads&&["project","stem","master"].map(kind=><section className="detail-section" key={kind}><h3>{kind==="project"?"Project files":kind==="stem"?"Stems":"Version master"}</h3><p>Attached to: {version?.label||"Current master / ungrouped files"}</p>{kind!=="master"&&<label>Upload {kind==="project"?"project files":"stems"}<input type="file" data-kind={kind} multiple disabled={busy||!loaded} onChange={e=>upload(e,kind)}/></label>}{kind==="project"&&<label>Upload project folder<input type="file" multiple {...{webkitdirectory:""}} disabled={busy||!loaded} onChange={e=>upload(e,"project-folder")}/></label>}{kind==="master"&&selection&&!versionMaster&&<label>Finish this version: upload master<input type="file" accept="audio/*,.wav,.aif,.aiff,.mp3,.m4a,.flac" disabled={busy||!loaded} onChange={e=>upload(e,"master")}/></label>}<ul>{group.filter(f=>f.kind===kind).map(f=><li key={f.id}><a href={apiUrl("/api/attachments/"+f.id)} download>{f.name}</a> · {(f.size/1048576).toFixed(1)} MB</li>)}</ul></section>)}
    {status&&<p role="status">{status}</p>}
  </section>;
}
