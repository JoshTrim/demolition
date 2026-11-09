import { Zip, ZipPassThrough } from "fflate";

export type SetFiles = { name: string; masters: File[]; stems: File[]; project: File[] };
export async function setFingerprint(set: SetFiles) {
  const entries: string[] = [];
  for (const [kind, files] of [["master", set.masters], ["stem", set.stems], ["project", set.project]] as const) {
    for (const file of files) {
      const hash = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      entries.push(JSON.stringify([kind, file.webkitRelativePath || file.name, Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2,"0")).join("")]));
    }
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(entries.sort().join("\n")));
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2,"0")).join("");
}
export const playableFile = (name: string) => /\.(wav|aif|aiff|mp3|m4a|flac|ogg|opus|aac)$/i.test(name);
export function defaultStemVersion(files: {kind:string;version_id?:string}[], versions:{id:string}[]) {
  return versions.find(version => files.some(file => file.version_id === version.id && file.kind === "stem"))?.id || "";
}
function safeParts(file: File) {
  const parts = (file.webkitRelativePath || file.name).split("/");
  return parts.some(p => !p || p === "." || p === ".." || p.includes("\\") || p === "__MACOSX") || parts.some(p => p === ".DS_Store" || p.startsWith("._")) ? undefined : parts;
}
const sectionKind = (part: string) => {
  const name = part.trim().toLowerCase();
  return name === "masters" ? "master" : name.endsWith(" project") ? "project" : name;
};
const sectionIndex = (parts: string[]) => parts.findIndex((p,i) => (i > 0 || !p.trim().toLowerCase().endsWith(" project")) && ["master", "stems", "project"].includes(sectionKind(p)));
export function setRelativePath(file: File) {
  const parts = safeParts(file);
  if (!parts) return "";
  const section = sectionIndex(parts);
  return parts.slice(section >= 0 ? section + 1 : 1).join("/") || file.name;
}
export function scanSets(files: File[], bulk: boolean) {
  const sets = new Map<string, SetFiles>();
  for (const file of files) {
    const parts = safeParts(file);
    if (!parts) continue;
    const section = sectionIndex(parts);
    if (section < 0 || section >= parts.length - 1) continue;
    const kind = sectionKind(parts[section]);
    if (kind !== "project" && !playableFile(file.name)) continue;
    const key = parts.slice(0, section).join("/") || parts[0];
    const name = section > 0 ? parts[section - 1] : parts[0];
    const set = sets.get(key) ?? { name, masters: [], stems: [], project: [] };
    set[kind === "master" ? "masters" : kind as "stems" | "project"].push(file);
    sets.set(key, set);
  }
  // A master may sit beside Stems/ and Project/, rather than inside Master/.
  // Only inspect files directly in the set root; never promote project samples
  // or audio in unrelated nested folders to master candidates.
  for (const file of files) {
    const parts = safeParts(file);
    if (!parts || !playableFile(file.name) || sectionIndex(parts) >= 0) continue;
    const root = parts.slice(0, -1).join("/");
    let set = sets.get(root);
    if (!set && !bulk && parts.length === 2) {
      set = { name: parts[0], masters: [], stems: [], project: [] };
      sets.set(root, set);
    }
    if (set) set.masters.push(file);
  }
  // Attaching an ordinary DAW project folder does not require a Project/ wrapper.
  if (!sets.size && !bulk) {
    const project = files.filter(file => safeParts(file));
    if (project.length) sets.set("project", {name: project[0].webkitRelativePath.split("/")[0] || "Project", masters: [], stems: [], project});
  }
  return [...sets.values()].sort((a,b) => a.name.localeCompare(b.name));
}
export async function archiveProject(set: SetFiles, _bulk: boolean, rawFolder = false) {
  if (set.project.reduce((n, f) => n + f.size, 0) >= 0xffff0000 || set.project.length >= 65535) throw new Error("Project exceeds the standard ZIP limit. Upload a ZIP64 archive manually.");
  const chunks: BlobPart[] = [];
  const zip = new Zip((err, bytes) => { if (err) throw err; chunks.push(new Uint8Array(bytes)); });
  for (const file of set.project.filter(file => safeParts(file)).sort((a, b) => a.webkitRelativePath.localeCompare(b.webkitRelativePath))) {
    const entry = new ZipPassThrough(rawFolder ? safeParts(file)!.join("/") : "Project/" + setRelativePath(file));
    entry.mtime = new Date(2000, 0, 1);
    zip.add(entry);
    const stream = file.stream().getReader();
    for (;;) { const { value, done } = await stream.read(); if (done) break; entry.push(value); }
    entry.push(new Uint8Array(), true);
  }
  zip.end();
  return new File(chunks, set.name + "-project.zip", { type: "application/zip" });
}
