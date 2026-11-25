"use client";
import { useState } from "react";

export default function PhoneTags({tags,available,disabled,onSet,remote=true}:{tags:string[];available:string[];disabled:boolean;onSet:(tag:string,applied:boolean)=>Promise<boolean|undefined>;remote?:boolean}) {
  const [draft,setDraft]=useState(""),[search,setSearch]=useState(""),[busy,setBusy]=useState(false),[status,setStatus]=useState("");
  const options=[...new Set([...available,...tags])].filter(tag=>!tags.some(applied=>applied.toLocaleLowerCase()===tag.toLocaleLowerCase())&&tag.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).sort((a,b)=>a.localeCompare(b));
  async function change(tag:string,applied:boolean) {
    setBusy(true);setStatus("");
    try {
      if(await onSet(tag,applied)){setStatus(remote?`${applied?"Apply":"Remove"} “${tag}” sent to desktop.`:`Tag “${tag}” ${applied?"applied":"removed"}.`);return true;}
      setStatus("Tag change failed. Please retry.");
    }catch{setStatus("Tag change failed. Please retry.");}finally{setBusy(false);}
    return false;
  }
  return <section className="phone-tags" aria-label="Edit track tags">
    <header><h2>Tags</h2><span>{tags.length} applied</span></header>
    <div className="phone-tag-chips" aria-label="Applied tags">{tags.map(tag=><button key={tag} disabled={disabled||busy} onClick={()=>void change(tag,false)} aria-label={`Remove tag ${tag}`}>{tag}<span aria-hidden="true">×</span></button>)}{!tags.length&&<p>No tags on this track.</p>}</div>
    <form onSubmit={async event=>{event.preventDefault();const tag=draft.trim().replace(/^#+/,"").slice(0,40).trim();if(tag&&await change(tag,true))setDraft("");}}>
      <label>Create or apply a tag<div><input aria-label="Create or apply a tag" value={draft} placeholder="Tag name" maxLength={40} disabled={disabled||busy} onChange={event=>setDraft(event.target.value)}/><button className="primary-button" disabled={disabled||busy||!draft.trim().replace(/^#+/,"").trim()}>Add tag</button></div></label>
    </form>
    <details><summary>Choose existing tags</summary><label>Find a tag<input type="search" placeholder="Filter tags" value={search} onChange={event=>setSearch(event.target.value)}/></label><div className="phone-tag-options">{options.map(tag=><button key={tag} disabled={disabled||busy} onClick={()=>void change(tag,true)} aria-label={`Apply tag ${tag}`}>+ {tag}</button>)}{!options.length&&<p>No other matching tags.</p>}</div></details>
    {status&&<p role="status">{status}</p>}
  </section>;
}
