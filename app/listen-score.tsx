"use client";

import { useState } from "react";

/** Mount with the current track/queue position as its key to reset disclosure. */
export default function ListenScore({ up, down, score, className = "rapid-vote-summary" }:{ up:number; down:number; score:number; className?:string }) {
  const [revealed, setRevealed] = useState(false);
  return <div className={className}>
    {revealed && <><span>{up} up</span><span>{down} down</span><strong>Score {score > 0 ? `+${score}` : score}</strong></>}
    <button type="button" className="secondary-button" aria-expanded={revealed} onClick={() => setRevealed(value => !value)}>{revealed ? "Hide score" : "Reveal score"}</button>
  </div>;
}
