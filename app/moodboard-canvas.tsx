"use client";
/* eslint-disable @next/next/no-img-element -- local user media */
import { useRef, useState } from "react";
export type CanvasPosition = { x: number; y: number; width: number; z: number; text?: boolean };
export type BoardItem = { id: number; title: string; note: string; kind: "image" | "video" | "audio" | "link"; source: "file" | "url"; url?: string; canvas?: CanvasPosition };
const limit = (n: number, max: number) => Math.max(0, Math.min(max, n));
export function boardPosition(item: BoardItem, index: number): CanvasPosition {
  return item.canvas ?? { x: 40 + (index % 6) * 340, y: 40 + Math.floor(index / 6) * 380, width: 300, z: index };
}
export default function MoodboardCanvas({ items, sources, onUpdate, onImages, onText, onRemove, onReference }: {
  items: BoardItem[]; sources: Record<number, string>; onUpdate: (id: number, patch: Partial<BoardItem>) => void;
  onImages: (files: File[], position: {x:number;y:number}) => Promise<void>; onText: (position: {x:number;y:number}) => void;
  onRemove: (item: BoardItem) => void; onReference: () => void;
}) {
  const [zoom, setZoom] = useState(0.75), [selected, setSelected] = useState<number>();
  const [draft, setDraft] = useState<{id:number;position:CanvasPosition}>();
  const [busy, setBusy] = useState(false), [status, setStatus] = useState("");
  const surface = useRef<HTMLDivElement>(null), viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{id:number;clientX:number;clientY:number;position:CanvasPosition;latest:CanvasPosition} | undefined>(undefined);
  const width = Math.max(2400, ...items.map((item,i) => {const p=boardPosition(item,i);return p.x+p.width+100;}));
  const height = Math.max(1600, ...items.map((item,i) => boardPosition(item,i).y+650));
  const active = items.find(item=>item.id===selected);
  const activePosition = active ? boardPosition(active,items.indexOf(active)) : undefined;
  const front = () => Math.max(0,...items.map((item,i)=>boardPosition(item,i).z))+1;
  const insertion = () => ({x:Math.round((viewport.current?.scrollLeft ?? 0)/zoom+40),y:Math.round((viewport.current?.scrollTop ?? 0)/zoom+40)});
  async function importImages(files:File[], position:{x:number;y:number}) {
    const images=files.filter(file=>file.type.startsWith("image/"));
    if (!images.length) {setStatus("Choose image files. Use Add reference for audio, video or links.");return;}
    setBusy(true); setStatus("Copying images…");
    try {await onImages(images,position);setStatus(images.length+" images added.");}
    catch(e){setStatus(e instanceof Error ? e.message : "Could not add images.");}
    finally{setBusy(false);}
  }
  function move(clientX:number,clientY:number) {
    const d=drag.current;if(!d)return;
    d.latest={...d.position,x:limit(Math.round(d.position.x+(clientX-d.clientX)/zoom),width-d.position.width),y:limit(Math.round(d.position.y+(clientY-d.clientY)/zoom),height-300)};
    setDraft({id:d.id,position:d.latest});
  }
  function finish(cancel=false) {
    const d=drag.current;if(d&&!cancel)onUpdate(d.id,{canvas:d.latest});
    drag.current=undefined;setDraft(undefined);
  }
  return <section className="board-workspace" aria-label="Moodboard canvas">
    <div className="board-toolbar"><label className="secondary-button">Add images<input className="sr-only" type="file" accept="image/*" multiple disabled={busy} onChange={e=>{void importImages(Array.from(e.target.files??[]),insertion());e.target.value="";}}/></label><button className="secondary-button" onClick={()=>onText(insertion())}>Add text</button><button className="secondary-button" onClick={onReference}>Add reference</button><label>Zoom<select value={zoom} onChange={e=>setZoom(Number(e.target.value))}>{[0.25,0.5,0.75,1,1.25,1.5].map(n=><option value={n} key={n}>{n*100}%</option>)}</select></label><button className="secondary-button" onClick={()=>viewport.current?.scrollTo({left:0,top:0})}>Top left</button></div>
    <p className="board-help">Drop images onto the canvas. Drag a card’s title bar to move it, or focus its move handle and use arrow keys. Select a card to resize it.</p>
    {active && activePosition && <div className="board-inspector"><strong>{active.title}</strong><label>Card width<input type="range" min="180" max="600" step="10" value={activePosition.width} onChange={e=>onUpdate(active.id,{canvas:{...activePosition,width:Number(e.target.value)}})}/></label><button className="secondary-button" onClick={()=>onUpdate(active.id,{canvas:{...activePosition,z:front()}})}>Bring to front</button><button className="secondary-button" onClick={()=>onRemove(active)}>Remove card</button></div>}
    <div className="board-viewport" ref={viewport} aria-label="Scrollable moodboard" onDragOver={e=>{if(e.dataTransfer.types.includes("Files"))e.preventDefault();}} onDrop={e=>{e.preventDefault();if(busy)return;const rect=surface.current?.getBoundingClientRect();if(rect)void importImages(Array.from(e.dataTransfer.files),{x:limit((e.clientX-rect.left)/zoom,width-320),y:limit((e.clientY-rect.top)/zoom,height-400)});}}>
      <div style={{width:width*zoom,height:height*zoom,overflow:"hidden",position:"relative"}}><div className="board-surface" ref={surface} style={{width,height,transform:`scale(${zoom})`}}>
        {!items.length&&<div className="board-empty">Drop images here or add a text card.</div>}
        {items.map((item,index)=>{const p=draft?.id===item.id?draft.position:boardPosition(item,index),src=item.source==="file"?sources[item.id]:item.url;return <article key={item.id} className={`board-card ${selected===item.id?"selected":""} ${p.text?"board-text":""}`} style={{left:p.x,top:p.y,width:p.width,zIndex:p.z}}>
          <button className="board-handle" aria-label={`Move ${item.title}`} onClick={()=>setSelected(item.id)} onPointerDown={e=>{if(e.button!==0)return;e.currentTarget.setPointerCapture(e.pointerId);setSelected(item.id);const position={...p,z:front()};drag.current={id:item.id,clientX:e.clientX,clientY:e.clientY,position,latest:position};setDraft({id:item.id,position});}} onPointerMove={e=>move(e.clientX,e.clientY)} onPointerUp={()=>finish()} onPointerCancel={()=>finish(true)} onKeyDown={e=>{const offsets:Record<string,number[]>={ArrowLeft:[-10,0],ArrowRight:[10,0],ArrowUp:[0,-10],ArrowDown:[0,10]};const delta=offsets[e.key];if(delta){e.preventDefault();setSelected(item.id);onUpdate(item.id,{canvas:{...p,x:limit(p.x+delta[0]*(e.shiftKey?5:1),width-p.width),y:limit(p.y+delta[1]*(e.shiftKey?5:1),height-300)}});}}}>⠿ {item.title}</button>
          {p.text ? <textarea aria-label={`Text for ${item.title}`} value={item.note} placeholder="Write a note…" maxLength={10000} onFocus={()=>setSelected(item.id)} onChange={e=>onUpdate(item.id,{note:e.target.value})}/> : <>
            {item.kind==="image"&&src&&<img src={src} alt={item.title} draggable={false}/>}
            {item.kind==="video"&&src&&<video src={src} controls preload="metadata"><track kind="captions"/></video>}
            {item.kind==="audio"&&src&&<audio src={src} controls preload="metadata"><track kind="captions"/></audio>}
            {item.kind==="link"&&item.url&&<a href={item.url} target="_blank" rel="noreferrer">{item.title} ↗</a>}
            {item.note&&<p>{item.note}</p>}
          </>}
        </article>;})}
      </div></div>
    </div>
    {status&&<p className="board-help" role="status">{status}</p>}
  </section>;
}
