"use client";
import { useEffect, useRef, useState } from "react";
import { scanSets, type SetFiles } from "./set-files";

type Target = { id: number; title: string; audioName?: string };
export type SetPlan = { set: SetFiles; target: string; master: string };
function Preview({ file, url }: { file?: File; url?: string }) {
  const player = useRef<HTMLAudioElement>(null);
  const [playing, play] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const audio = player.current;
    if (!audio) return;
    const src = file ? URL.createObjectURL(file) : url;
    if (src) audio.src = src;
    return () => { audio.pause(); audio.removeAttribute("src"); if (file && src) URL.revokeObjectURL(src); };
  }, [file, url]);
  return <><audio ref={player} onPlay={() => play(true)} onPause={() => play(false)} onEnded={() => play(false)}><track kind="captions" /></audio><button type="button" className="secondary-button" onClick={() => { if (playing) player.current?.pause(); else { document.querySelectorAll("audio").forEach((audio) => audio.pause()); player.current?.play().catch(() => setError("This browser could not preview the file.")); } }}>{playing ? "Pause" : file ? "Audition incoming" : "Audition current"}</button>{error && <small>{error}</small>}</>;
}

export default function SetImport({ demos, single, audioUrl, onImport }: { demos: Target[]; single?: Target; audioUrl: (id: number) => string; onImport: (plans: SetPlan[], bulk: boolean, progress: (value: string) => void) => Promise<void> }) {
  const [plans, setPlans] = useState<SetPlan[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [notice, setNotice] = useState("");
  const [failed, setFailed] = useState(false);
  const bulk = !single;
  function choose(files: File[]) {
    const sets = scanSets(files, bulk);
    setFailed(false);
    setNotice(sets.length ? "" : bulk ? "No sets found. Choose the parent containing your set folders." : "Choose the set folder containing Master, Stems or Project.");
    setStatus("");
    setPlans(sets.map((set) => {
      const matches = single ? [single] : demos.filter((demo) => demo.title.toLowerCase() === set.name.toLowerCase() || set.masters.some((f) => demo.audioName?.toLowerCase() === f.name.toLowerCase()));
      const target = matches.length === 1 ? String(matches[0].id) : matches.length ? "choose" : "new";
      return { set, target, master: matches.some((d) => d.audioName) ? "keep" : set.masters.length === 1 ? "0" : set.masters.length ? "choose" : "keep" };
    }));
  }
  function edit(index: number, patch: Partial<SetPlan>) { setPlans((items) => items.map((item, i) => i === index ? { ...item, ...patch } : item)); }
  const active = plans.filter((p) => p.target !== "skip");
  const ids = active.filter((p) => p.target !== "new").map((p) => p.target);
  const duplicate = new Set(ids).size !== ids.length;
  return <div className="set-import"><label className="secondary-button">{single ? "Attach set folder" : "Import parent folder of sets"}<input type="file" className="sr-only" multiple {...{ webkitdirectory: "" }} disabled={busy} onChange={(event) => { choose(Array.from(event.target.files ?? [])); event.target.value = ""; }} /></label>{notice && <p role="status">{notice}</p>}
    {plans.length > 0 && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-label="Review set import"><h2>Review set import</h2><p>Only managed copies are imported. Choose a master or keep the current audio.</p>
      <fieldset disabled={busy}>{plans.map((plan, index) => { const target = demos.find((d) => String(d.id) === plan.target); const file = plan.set.masters[Number(plan.master)];
        return <section className="detail-section" key={plan.set.name}><h3>{plan.set.name}</h3><small>{plan.set.stems.length} stems · {plan.set.project.length} project files</small>
          {single ? <p>Attach to {single.title}</p> : <label>Destination<select value={plan.target} onChange={(e) => edit(index, { target: e.target.value, master: "keep" })}><option value="choose" disabled>Choose matching demo</option><option value="new">Create new demo</option><option value="skip">Skip set</option>{demos.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</select></label>}
          {plan.target !== "skip" && <><label>Master<select value={plan.master} onChange={(e) => edit(index, { master: e.target.value })}><option value="choose" disabled>Choose a master</option><option value="keep">{target?.audioName ? "Keep current master" : "No master"}</option>{plan.set.masters.map((f, i) => <option value={i} key={f.webkitRelativePath}>{f.webkitRelativePath.split("/").slice(bulk ? 3 : 2).join("/")}</option>)}</select></label>{target?.audioName && <Preview url={audioUrl(target.id)} />}{file && <Preview key={file.webkitRelativePath} file={file} />}{target?.audioName && file && <p>This will replace the managed master for {target.title}.</p>}</>}
        </section>; })}</fieldset>{duplicate && <p role="alert">Choose a different destination for each set.</p>}
      <p role="status">{status}</p><button disabled={busy} className="secondary-button" onClick={() => setPlans([])}>Close</button> <button className="primary-button" disabled={busy || failed || duplicate || !active.length || active.some((p) => p.target === "choose" || p.master === "choose" || (p.target === "new" && p.master === "keep" && !p.set.stems.length && !p.set.project.length))} onClick={async () => { setBusy(true); try { await onImport(active, bulk, setStatus); setPlans([]); setNotice("Set import complete."); } catch (e) { setFailed(true); setStatus(e instanceof Error ? e.message : "Set import failed."); } finally { setBusy(false); } }}>Import {active.length} {active.length === 1 ? "set" : "sets"}</button>
    </section></div>}
  </div>;
}
