"use client";
import { useEffect, useState } from "react";
import DemoMixer from "./demo-mixer";
type FileRecord = { id: string; name: string; kind: string; size: number; version_id?: string; created_at: number };
type Version = { id: string; label: string; notes: string; created_at: number };
type Props = { uuid: string; master?: string; apiUrl: (path: string) => string; revision?: number; autoPlay?: boolean; onEnded?: () => void; onStarted?: () => void; uploads?: boolean; beforeUpload?: () => Promise<void> };
async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options), data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}
export default function DemoFiles({ uuid, master, apiUrl, revision, autoPlay, onEnded, onStarted, uploads, beforeUpload }: Props) {
  const [files, setFiles] = useState<FileRecord[]>([]), [versions, setVersions] = useState<Version[]>([]);
  const [selection, setSelection] = useState("");
  const [label, setLabel] = useState(""), [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false), [status, setStatus] = useState(""), [loaded, setLoaded] = useState(false);
  const base = "/api/demos/" + encodeURIComponent(uuid);
  useEffect(() => {
    let active = true;
    Promise.all([request<FileRecord[]>(apiUrl(base + "/attachments")), request<Version[]>(apiUrl(base + "/file-versions"))]).then(([f, v]) => { if (active) { setFiles(f); setVersions(v); setLoaded(true); } }).catch((e) => { if (active) setStatus(e.message); });
    return () => { active = false; };
    // URL builder is supplied by the parent and may change identity on render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, revision]);
  const version = versions.find((v) => v.id === selection);
  const group = files.filter((f) => (f.version_id || "") === selection);
  async function create() {
    await beforeUpload?.();
    const result = await request<{ id: string }>(apiUrl(base + "/file-versions"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: label.trim() || new Date().toLocaleString(), notes }) });
    setVersions(await request<Version[]>(apiUrl(base + "/file-versions")));
    setFiles(await request<FileRecord[]>(apiUrl(base + "/attachments")));
    setSelection(result.id);
    return result.id;
  }
  async function upload(event: React.ChangeEvent<HTMLInputElement>, kind: string) {
    const input = event.currentTarget, incoming = [...input.files || []];
    if (!incoming.length) return;
    setBusy(true);
    let completed = 0;
    try {
      await beforeUpload?.();
      const id = selection || await create();
      for (const file of incoming) {
        setStatus("Uploading " + file.name);
        setFiles(await request<FileRecord[]>(apiUrl(base + "/attachments?kind=" + kind + "&version=" + encodeURIComponent(id)), { method: "POST", headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name) }, body: file }));
        completed++;
      }
      setStatus(completed + " files saved.");
    } catch (e) { setStatus(completed + " files saved. " + (e instanceof Error ? e.message : "Upload failed")); }
    finally { setBusy(false); input.value = ""; }
  }
  const versionMaster = group.find((f) => f.kind === "master");
  return <section className={uploads ? "track-discussion demo-attachments" : "track-discussion"} id={uploads ? "demo-files" : undefined} aria-label={uploads ? "Demo files and versions" : "Audition sources"}>
    <h2>{uploads ? "Files & versions" : "Playback source"}</h2>
    <label>File version<select disabled={busy} value={selection} onChange={(e) => { setSelection(e.target.value); const v = versions.find((v) => v.id === e.target.value); setLabel(v?.label || ""); setNotes(v?.notes || ""); }}><option value="">Current master / older ungrouped uploads</option>{versions.map((v) => <option value={v.id} key={v.id}>{v.label} · {new Date(v.created_at).toLocaleString()}</option>)}</select></label>
    {version && <p>{version.notes || "No version notes."}</p>}
    {uploads && <div className="detail-section"><label>Version label<input maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Mix 4 — shorter intro" /></label><label>Version notes<textarea maxLength={5000} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      <button className="secondary-button" disabled={busy} onClick={async () => { setBusy(true); try { await create(); setStatus("Version created with a copy of the current master."); } catch (e) { setStatus(e instanceof Error ? e.message : "Could not create version"); } finally { setBusy(false); } }}>New version from current master</button>
      {version && <button className="secondary-button" disabled={busy || !label.trim()} onClick={async () => { setBusy(true); try { setVersions(await request<Version[]>(apiUrl(base + "/file-versions"), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: version.id, label, notes }) })); setStatus("Version notes saved."); } catch (e) { setStatus(e instanceof Error ? e.message : "Save failed"); } finally { setBusy(false); } }}>Save label & notes</button>}
      <p>Each version keeps its own master copy, stems and project files. Choose a version before adding related files. Older ungrouped uploads remain available.</p></div>}
    {loaded && <div className="demo-mixer-panel"><DemoMixer key={selection} files={group} master={selection ? versionMaster ? apiUrl("/api/attachments/" + versionMaster.id + "?play=1") : undefined : master} stemUrl={(id) => apiUrl("/api/attachments/" + id + "?play=1")} autoPlay={autoPlay} onEnded={onEnded} onStarted={onStarted} /></div>}
    {uploads && ["project", "stem", "master"].map((kind) => <section className="detail-section" key={kind}><h3>{kind === "project" ? "Project files" : kind === "stem" ? "Stems" : "Master snapshot"}</h3>{kind !== "master" && <label>Upload {kind === "project" ? "project files" : "stems"}<input type="file" data-kind={kind} multiple disabled={busy || !loaded} onChange={(e) => upload(e, kind)} /></label>}<ul>{group.filter((f) => f.kind === kind).map((f) => <li key={f.id}><a href={apiUrl("/api/attachments/" + f.id)} download>{f.name}</a> · {(f.size / 1048576).toFixed(1)} MB · {new Date(f.created_at).toLocaleString()}</li>)}</ul></section>)}
    {status && <p role="status">{status}</p>}
  </section>;
}
