import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const dataDirectory = path.resolve(process.cwd(), "data");
export const audioDirectory = path.join(dataDirectory, "audio");
export const mediaDirectory = path.join(dataDirectory, "media");

mkdirSync(audioDirectory, { recursive: true });
mkdirSync(mediaDirectory, { recursive: true });

const database = new DatabaseSync(path.join(dataDirectory, "demolition.sqlite"));
database.exec("PRAGMA foreign_keys = ON");
database.exec("PRAGMA journal_mode = WAL");
database.exec("PRAGMA synchronous = NORMAL");
database.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    name TEXT PRIMARY KEY,
    color TEXT NOT NULL CHECK (color IN ('coral', 'yellow', 'blue', 'violet')),
    mood TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS demos (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    bpm INTEGER NOT NULL DEFAULT 0,
    musical_key TEXT NOT NULL DEFAULT '—',
    duration TEXT NOT NULL DEFAULT '00:00',
    status TEXT NOT NULL CHECK (status IN ('unheard', 'revisit', 'shaping', 'finished')),
    tags_json TEXT NOT NULL DEFAULT '[]',
    note TEXT NOT NULL DEFAULT '',
    next_action TEXT NOT NULL DEFAULT '',
    rating INTEGER NOT NULL DEFAULT 0,
    project TEXT NOT NULL DEFAULT 'Unsorted',
    updated_at INTEGER NOT NULL,
    audio_name TEXT,
    checksum TEXT,
    file_size INTEGER,
    copy_verified_at INTEGER,
    creation_date TEXT
  );

  CREATE TABLE IF NOT EXISTS tracklist (
    project TEXT NOT NULL,
    demo_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (project, demo_id),
    FOREIGN KEY (demo_id) REFERENCES demos(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS project_media (
    id INTEGER PRIMARY KEY,
    project TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'link')),
    source TEXT NOT NULL CHECK (source IN ('file', 'url')),
    title TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    file_name TEXT,
    url TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS stored_files (
    entity_type TEXT NOT NULL CHECK (entity_type IN ('audio', 'media')),
    entity_id INTEGER NOT NULL,
    storage_name TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (entity_type, entity_id)
  );

  CREATE INDEX IF NOT EXISTS idx_demos_project ON demos(project);
  CREATE INDEX IF NOT EXISTS idx_demos_status_updated ON demos(status, updated_at);
  CREATE INDEX IF NOT EXISTS idx_media_project_created ON project_media(project, created_at);
  CREATE INDEX IF NOT EXISTS idx_tracklist_project_position ON tracklist(project, position);
  PRAGMA optimize;
`);

const listProjects = database.prepare("SELECT name, color, mood FROM projects ORDER BY position");
const listDemos = database.prepare("SELECT * FROM demos ORDER BY updated_at DESC");
const listTracklist = database.prepare("SELECT project, demo_id, position FROM tracklist ORDER BY project, position");
const listMedia = database.prepare("SELECT * FROM project_media ORDER BY created_at DESC");

export function readWorkspace() {
  const projects = listProjects.all();
  const demos = listDemos.all().map((row) => ({
    id: Number(row.id), title: row.title, bpm: Number(row.bpm), key: row.musical_key,
    duration: row.duration, status: row.status, tags: JSON.parse(row.tags_json || "[]"),
    note: row.note, nextAction: row.next_action, rating: Number(row.rating), project: row.project,
    updatedAt: Number(row.updated_at), audioName: row.audio_name ?? undefined,
    checksum: row.checksum ?? undefined, fileSize: row.file_size == null ? undefined : Number(row.file_size),
    copyVerifiedAt: row.copy_verified_at == null ? undefined : Number(row.copy_verified_at),
    creationDate: row.creation_date ?? undefined,
  }));
  const orders = {};
  for (const row of listTracklist.all()) {
    orders[row.project] ??= [];
    orders[row.project].push(Number(row.demo_id));
  }
  const media = listMedia.all().map((row) => ({
    id: Number(row.id), project: row.project, kind: row.kind, source: row.source,
    title: row.title, note: row.note, fileName: row.file_name ?? undefined,
    url: row.url ?? undefined, createdAt: Number(row.created_at),
  }));
  return { projects, demos, orders, media, empty: projects.length === 0 && demos.length === 0 && media.length === 0 };
}

const insertProject = database.prepare("INSERT INTO projects (name, color, mood, position) VALUES (?, ?, ?, ?)");
const insertDemo = database.prepare(`
  INSERT INTO demos (id, title, bpm, musical_key, duration, status, tags_json, note, next_action, rating, project, updated_at, audio_name, checksum, file_size, copy_verified_at, creation_date)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertTrack = database.prepare("INSERT INTO tracklist (project, demo_id, position) VALUES (?, ?, ?)");
const insertMedia = database.prepare("INSERT INTO project_media (id, project, kind, source, title, note, file_name, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");

export function writeWorkspace(payload) {
  const projects = Array.isArray(payload.projects) ? payload.projects : [];
  const demos = Array.isArray(payload.demos) ? payload.demos : [];
  const media = Array.isArray(payload.media) ? payload.media : [];
  const orders = payload.orders && typeof payload.orders === "object" ? payload.orders : {};
  const demoIds = new Set(demos.map((demo) => Number(demo.id)));
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("DELETE FROM tracklist; DELETE FROM project_media; DELETE FROM demos; DELETE FROM projects;");
    projects.forEach((project, position) => insertProject.run(project.name, project.color, project.mood ?? "", position));
    demos.forEach((demo) => insertDemo.run(
      demo.id, demo.title, demo.bpm || 0, demo.key || "—", demo.duration || "00:00", demo.status,
      JSON.stringify(Array.isArray(demo.tags) ? demo.tags : []), demo.note ?? "", demo.nextAction ?? "",
      demo.rating || 0, demo.project || "Unsorted", demo.updatedAt || Date.now(), demo.audioName ?? null,
      demo.checksum ?? null, demo.fileSize ?? null, demo.copyVerifiedAt ?? null, demo.creationDate ?? null,
    ));
    media.forEach((item) => insertMedia.run(item.id, item.project, item.kind, item.source, item.title, item.note ?? "", item.fileName ?? null, item.url ?? null, item.createdAt || Date.now()));
    for (const [project, ids] of Object.entries(orders)) {
      if (!Array.isArray(ids)) continue;
      ids.forEach((id, position) => { if (demoIds.has(Number(id))) insertTrack.run(project, id, position); });
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function getStoredFile(type, id) {
  return database.prepare("SELECT * FROM stored_files WHERE entity_type = ? AND entity_id = ?").get(type, id);
}

export function saveStoredFile(type, id, storageName, originalName, mimeType, sizeBytes) {
  database.prepare(`
    INSERT INTO stored_files (entity_type, entity_id, storage_name, original_name, mime_type, size_bytes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(entity_type, entity_id) DO UPDATE SET storage_name = excluded.storage_name, original_name = excluded.original_name,
      mime_type = excluded.mime_type, size_bytes = excluded.size_bytes, updated_at = excluded.updated_at
  `).run(type, id, storageName, originalName, mimeType, sizeBytes, Date.now());
}

export function removeStoredFile(type, id) {
  database.prepare("DELETE FROM stored_files WHERE entity_type = ? AND entity_id = ?").run(type, id);
}

export function storedFileBytes() {
  return Number(database.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS total FROM stored_files").get().total);
}
