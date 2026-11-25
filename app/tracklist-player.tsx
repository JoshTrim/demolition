"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import TrimControls from "./trim-controls";

const clock = (seconds:number) => Math.floor(seconds/60)+":"+String(Math.floor(seconds%60)).padStart(2,"0");

export default function TracklistPlayer({src,onEnded,onStarted,children,trimStart=0,trimEnd,onTrim,tags}:{src:string;onEnded:()=>void;onStarted:()=>void;children?:ReactNode;trimStart?:number;trimEnd?:number;onTrim?:(range:{start:number;end:number})=>void;tags?:ReactNode}) {
  const audio=useRef<HTMLAudioElement>(null);
  const [playing,setPlaying]=useState(false),[position,setPosition]=useState(0),[duration,setDuration]=useState(0),[error,setError]=useState("");
  const [advanced,setAdvanced]=useState(false);
  const started=useRef(false),callbacks=useRef({onEnded,onStarted});
  const trimmed=useRef(false);
  const start=Math.max(0,Math.min(trimStart,Math.max(0,duration-0.1))),end=Math.max(start,Math.min(trimEnd??duration,duration));
  useEffect(()=>{callbacks.current={onEnded,onStarted};},[onEnded,onStarted]);
  useEffect(()=>{
    const player=audio.current;
    function otherPlayback(event:Event){if((event as CustomEvent).detail!==player)player?.pause();}
    document.addEventListener("demolition-mixer-play",otherPlayback);
    return()=>{player?.pause();document.removeEventListener("demolition-mixer-play",otherPlayback);};
  },[]);
  useEffect(()=>{
    if(!playing)return;
    const timer=window.setInterval(()=>{if(audio.current){setPosition(audio.current.currentTime);if(trimmed.current&&audio.current.currentTime>=end){audio.current.pause();audio.current.currentTime=end;setPosition(end);trimmed.current=false;}}},80);
    return()=>clearInterval(timer);
  },[playing,end]);
  async function play(){setError("");try{await audio.current?.play();}catch{setError("Playback could not start. Press Play to retry.");}}
  function seek(time:number){trimmed.current=false;const at=Math.max(0,Math.min(duration,time));if(audio.current)audio.current.currentTime=at;setPosition(at);}
  function finish(){setPlaying(false);if(trimmed.current){trimmed.current=false;return;}callbacks.current.onEnded();}
  return <section className="tracklist-player" aria-label="Tracklist playback controls">
    <audio ref={audio} src={src} preload="metadata" onLoadedMetadata={event=>{const length=event.currentTarget.duration;setDuration(Number.isFinite(length)?length:0);void play();}} onPlay={()=>{
      document.querySelectorAll("audio").forEach(player=>{if(player!==audio.current)player.pause();});
      document.dispatchEvent(new CustomEvent("demolition-mixer-play",{detail:audio.current}));
      setPlaying(true);setError("");if(!started.current){started.current=true;callbacks.current.onStarted();}
    }} onPause={()=>setPlaying(false)} onTimeUpdate={event=>setPosition(event.currentTarget.currentTime)} onEnded={finish} onError={()=>{setPlaying(false);setError("This master could not be loaded. Try the next track or inspect its files.");}}><track kind="captions"/></audio>
    <div className="tracklist-transport"><button className="primary-button" onClick={()=>playing?audio.current?.pause():void play()} aria-label={playing?"Pause tracklist playback":"Play tracklist playback"}>{playing?"Ⅱ Pause":"▶ Play"}</button><button className="secondary-button" disabled={!duration} onClick={()=>seek(position-10)} aria-label="Seek back 10 seconds">−10s</button><button className="secondary-button" disabled={!duration} onClick={()=>seek(position+10)} aria-label="Seek forward 10 seconds">+10s</button><output aria-label="Playback time">{clock(position)} / {clock(duration)}</output></div>
    <div className="tracklist-live-timeline"><div className="tracklist-progress" aria-hidden="true"><span style={{width:(duration?position/duration*100:0)+"%"}}/><i style={{left:(duration?position/duration*100:0)+"%"}}/></div><input type="range" aria-label="Seek tracklist playback" aria-valuetext={`${clock(position)} of ${clock(duration)}`} min={0} max={duration} step="0.1" value={Math.min(position,duration)} disabled={!duration} onChange={event=>seek(Number(event.target.value))}/></div>
    {error&&<p role="alert">{error}</p>}
    {onTrim&&<TrimControls duration={duration} start={start} end={end} position={position} onChange={onTrim} onPreview={()=>{seek(start);trimmed.current=true;void play();}}/>}
    {tags}
    {children&&<details onToggle={event=>setAdvanced(event.currentTarget.open)}><summary>Versions, stems &amp; timed notes</summary>{advanced&&children}</details>}
  </section>;
}
