import { Zip, ZipPassThrough } from "fflate";

export type SetFiles = { name: string; masters: File[]; stems: File[]; project: File[] };
export const playableFile = (name: string) => /\.(wav|aif|aiff|mp3|m4a|flac|ogg|opus|aac)$/i.test(name);
export function scanSets(files: File[], bulk: boolean) {
  const sets = new Map<string, SetFiles>();
  for (const file of files) {
    const parts = file.webkitRelativePath.split("/");
    const section = bulk ? 2 : 1;
    if (parts.length < section + 2 || parts.some((p) => !p || p === "." || p === ".." || p.includes("\\") || p === "__MACOSX") || file.name === ".DS_Store" || file.name.startsWith("._")) continue;
    const kind = parts[section].toLowerCase();
    if (kind !== "project" && (!(kind === "master" || kind === "stems") || !playableFile(file.name))) continue;
    const name = parts[section - 1];
    const set = sets.get(name) ?? { name, masters: [], stems: [], project: [] };
    set[kind === "master" ? "masters" : kind].push(file);
    sets.set(name, set);
  }
  return [...sets.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export async function archiveProject(set: SetFiles, bulk: boolean) {
  if (set.project.reduce((n, f) => n + f.size, 0) >= 0xffff0000 || set.project.length >= 65535) throw new Error("Project exceeds the standard ZIP limit. Upload a ZIP64 archive manually.");
  const chunks: BlobPart[] = [];
  const zip = new Zip((err, bytes) => { if (err) throw err; chunks.push(new Uint8Array(bytes)); });
  for (const file of [...set.project].sort((a, b) => a.webkitRelativePath.localeCompare(b.webkitRelativePath))) {
    const entry = new ZipPassThrough(file.webkitRelativePath.split("/").slice(bulk ? 2 : 1).join("/"));
    entry.mtime = new Date(2000, 0, 1);
    zip.add(entry);
    const stream = file.stream().getReader();
    for (;;) { const { value, done } = await stream.read(); if (done) break; entry.push(value); }
    entry.push(new Uint8Array(), true);
  }
  zip.end();
  return new File(chunks, set.name + "-project.zip", { type: "application/zip" });
}
