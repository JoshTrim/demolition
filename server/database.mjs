import { generateKeyPairSync, randomBytes, randomUUID, sign, timingSafeEqual, verify } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const dataDirectory = path.resolve(process.cwd(), "data");
export const audioDirectory = path.join(dataDirectory, "audio");
export const mediaDirectory = path.join(dataDirectory, "media");
export const databasePath = path.resolve(process.env.DEMOLITION_DATABASE_PATH || path.join(dataDirectory, "demolition.sqlite"));

mkdirSync(audioDirectory, { recursive: true });
mkdirSync(mediaDirectory, { recursive: true });
mkdirSync(path.dirname(databasePath), { recursive: true });

const database = new DatabaseSync(databasePath);
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

  CREATE TABLE IF NOT EXISTS tags (
    name TEXT PRIMARY KEY COLLATE NOCASE,
    created_at INTEGER NOT NULL
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
    favorite INTEGER NOT NULL DEFAULT 0,
    project TEXT NOT NULL DEFAULT 'Unsorted',
    updated_at INTEGER NOT NULL,
    audio_name TEXT,
    checksum TEXT,
    file_size INTEGER,
    copy_verified_at INTEGER,
    creation_date TEXT,
    trim_start_seconds REAL,
    trim_end_seconds REAL,
    uuid TEXT,
    owner_id TEXT,
    source_friend_id TEXT
  );

  CREATE TABLE IF NOT EXISTS tracklist (
    project TEXT NOT NULL,
    demo_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (project, demo_id),
    FOREIGN KEY (demo_id) REFERENCES demos(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS listens (
    id INTEGER PRIMARY KEY,
    demo_id INTEGER NOT NULL,
    verdict TEXT NOT NULL CHECK (verdict IN ('up', 'down')),
    note TEXT NOT NULL DEFAULT '',
    listened_at INTEGER NOT NULL,
    event_uuid TEXT,
    demo_uuid TEXT,
    author_id TEXT,
    author_name TEXT,
    author_public_key TEXT,
    signature TEXT,
    FOREIGN KEY (demo_id) REFERENCES demos(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS timed_notes (
    id INTEGER PRIMARY KEY,
    note_uuid TEXT NOT NULL UNIQUE,
    demo_id INTEGER NOT NULL,
    demo_uuid TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL,
    author_public_key TEXT NOT NULL,
    start_seconds REAL NOT NULL CHECK (start_seconds >= 0),
    end_seconds REAL NOT NULL CHECK (end_seconds >= start_seconds),
    note TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    signature TEXT,
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

  CREATE TABLE IF NOT EXISTS owner_identity (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    instance_id TEXT NOT NULL UNIQUE,
    public_key TEXT NOT NULL,
    private_key TEXT NOT NULL,
    peer_url TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS friends (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    instance_id TEXT NOT NULL UNIQUE,
    peer_url TEXT NOT NULL,
    public_key TEXT NOT NULL,
    inbound_token TEXT NOT NULL UNIQUE,
    outbound_token TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'connected',
    created_at INTEGER NOT NULL,
    last_synced_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS pairing_invites (
    token TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS demo_shares (
    demo_uuid TEXT NOT NULL,
    friend_id TEXT NOT NULL,
    share_audio INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (demo_uuid, friend_id),
    FOREIGN KEY (friend_id) REFERENCES friends(id) ON DELETE CASCADE
  );
`);

function addColumn(table, column, definition) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

addColumn("demos", "uuid", "TEXT");
addColumn("demos", "owner_id", "TEXT");
addColumn("demos", "source_friend_id", "TEXT");
addColumn("demos", "favorite", "INTEGER NOT NULL DEFAULT 0");
addColumn("demos", "trim_start_seconds", "REAL");
addColumn("demos", "trim_end_seconds", "REAL");
addColumn("listens", "event_uuid", "TEXT");
addColumn("listens", "demo_uuid", "TEXT");
addColumn("listens", "author_id", "TEXT");
addColumn("listens", "author_name", "TEXT");
addColumn("listens", "author_public_key", "TEXT");
addColumn("listens", "signature", "TEXT");

database.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_demos_uuid ON demos(uuid) WHERE uuid IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_listens_event_uuid ON listens(event_uuid) WHERE event_uuid IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_demos_project ON demos(project);
  CREATE INDEX IF NOT EXISTS idx_demos_status_updated ON demos(status, updated_at);
  CREATE INDEX IF NOT EXISTS idx_media_project_created ON project_media(project, created_at);
  CREATE INDEX IF NOT EXISTS idx_tracklist_project_position ON tracklist(project, position);
  CREATE INDEX IF NOT EXISTS idx_listens_demo_listened ON listens(demo_id, listened_at DESC);
  CREATE INDEX IF NOT EXISTS idx_listens_demo_uuid ON listens(demo_uuid, listened_at DESC);
  CREATE INDEX IF NOT EXISTS idx_timed_notes_demo_range ON timed_notes(demo_uuid, start_seconds, end_seconds);
  CREATE INDEX IF NOT EXISTS idx_shares_friend ON demo_shares(friend_id, demo_uuid);
  PRAGMA optimize;
`);

function createOwner() {
  const existing = database.prepare("SELECT * FROM owner_identity LIMIT 1").get();
  if (existing) return existing;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const owner = {
    id: randomUUID(), display_name: "Josh", instance_id: randomUUID(),
    public_key: publicKey.export({ type: "spki", format: "pem" }),
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    peer_url: "http://127.0.0.1:3001", created_at: Date.now(),
  };
  database.prepare("INSERT INTO owner_identity (id, display_name, instance_id, public_key, private_key, peer_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(owner.id, owner.display_name, owner.instance_id, owner.public_key, owner.private_key, owner.peer_url, owner.created_at);
  return owner;
}

const owner = createOwner();

function canonicalListen(listen) {
  return JSON.stringify({
    eventUuid: listen.eventUuid, demoUuid: listen.demoUuid, authorId: listen.authorId,
    verdict: listen.verdict, note: listen.note ?? "", listenedAt: Number(listen.listenedAt),
  });
}

function signListen(listen) {
  return sign(null, Buffer.from(canonicalListen(listen)), owner.private_key).toString("base64");
}

function verifyListen(listen) {
  try {
    return verify(null, Buffer.from(canonicalListen(listen)), listen.authorPublicKey, Buffer.from(listen.signature, "base64"));
  } catch {
    return false;
  }
}

function canonicalTimedNote(note) {
  return JSON.stringify({
    noteUuid: note.noteUuid, demoUuid: note.demoUuid, authorId: note.authorId,
    startSeconds: Number(note.startSeconds), endSeconds: Number(note.endSeconds),
    note: note.note ?? "", createdAt: Number(note.createdAt),
  });
}

function signTimedNote(note) {
  return sign(null, Buffer.from(canonicalTimedNote(note)), owner.private_key).toString("base64");
}

function verifyTimedNote(note) {
  try {
    return verify(null, Buffer.from(canonicalTimedNote(note)), note.authorPublicKey, Buffer.from(note.signature, "base64"));
  } catch {
    return false;
  }
}

database.exec("BEGIN IMMEDIATE");
try {
  const legacyDemos = database.prepare("SELECT id FROM demos WHERE uuid IS NULL OR uuid = ''").all();
  const updateDemoIdentity = database.prepare("UPDATE demos SET uuid = ?, owner_id = COALESCE(NULLIF(owner_id, ''), ?) WHERE id = ?");
  for (const demo of legacyDemos) updateDemoIdentity.run(randomUUID(), owner.id, demo.id);
  database.prepare("UPDATE demos SET owner_id = ? WHERE owner_id IS NULL OR owner_id = ''").run(owner.id);
  const legacyListens = database.prepare(`
    SELECT listens.*, demos.uuid AS resolved_demo_uuid
    FROM listens JOIN demos ON demos.id = listens.demo_id
    WHERE listens.event_uuid IS NULL OR listens.event_uuid = '' OR listens.author_id IS NULL OR listens.author_id = ''
  `).all();
  const updateListenIdentity = database.prepare("UPDATE listens SET event_uuid = ?, demo_uuid = ?, author_id = ?, author_name = ?, author_public_key = ?, signature = ? WHERE id = ?");
  for (const row of legacyListens) {
    const listen = {
      eventUuid: row.event_uuid || randomUUID(), demoUuid: row.demo_uuid || row.resolved_demo_uuid,
      authorId: owner.id, verdict: row.verdict, note: row.note, listenedAt: Number(row.listened_at),
    };
    updateListenIdentity.run(listen.eventUuid, listen.demoUuid, owner.id, owner.display_name, owner.public_key, signListen(listen), row.id);
  }
  database.exec("COMMIT");
} catch (error) {
  database.exec("ROLLBACK");
  throw error;
}

const listProjects = database.prepare("SELECT name, color, mood FROM projects ORDER BY position");
const listTags = database.prepare("SELECT name, created_at FROM tags ORDER BY name COLLATE NOCASE");
const listDemos = database.prepare("SELECT * FROM demos ORDER BY updated_at DESC");
const listTracklist = database.prepare("SELECT project, demo_id, position FROM tracklist ORDER BY project, position");
const listMedia = database.prepare("SELECT * FROM project_media ORDER BY created_at DESC");
const listListens = database.prepare("SELECT * FROM listens ORDER BY listened_at DESC, id DESC");
const listTimedNotes = database.prepare("SELECT * FROM timed_notes ORDER BY start_seconds, created_at");
const listFriends = database.prepare("SELECT id, display_name, instance_id, peer_url, public_key, status, created_at, last_synced_at FROM friends ORDER BY display_name COLLATE NOCASE");
const listShares = database.prepare("SELECT demo_uuid, friend_id, share_audio FROM demo_shares ORDER BY demo_uuid, friend_id");

function publicOwner(row = owner) {
  return {
    id: row.id, displayName: row.display_name, instanceId: row.instance_id,
    publicKey: row.public_key, peerUrl: row.peer_url, createdAt: Number(row.created_at),
  };
}

function mapDemo(row) {
  return {
    id: Number(row.id), uuid: row.uuid, ownerId: row.owner_id, sourceFriendId: row.source_friend_id ?? undefined,
    title: row.title, bpm: Number(row.bpm), key: row.musical_key, duration: row.duration,
    status: row.status, tags: JSON.parse(row.tags_json || "[]"), note: row.note,
    nextAction: row.next_action, rating: Number(row.rating), favorite: Boolean(row.favorite), project: row.project,
    updatedAt: Number(row.updated_at), audioName: row.audio_name ?? undefined,
    checksum: row.checksum ?? undefined, fileSize: row.file_size == null ? undefined : Number(row.file_size),
    copyVerifiedAt: row.copy_verified_at == null ? undefined : Number(row.copy_verified_at),
    creationDate: row.creation_date ?? undefined,
    trimStartSeconds: row.trim_start_seconds == null ? undefined : Number(row.trim_start_seconds),
    trimEndSeconds: row.trim_end_seconds == null ? undefined : Number(row.trim_end_seconds),
  };
}

function mapListen(row) {
  return {
    id: Number(row.id), eventUuid: row.event_uuid, demoId: Number(row.demo_id), demoUuid: row.demo_uuid,
    authorId: row.author_id, authorName: row.author_name, authorPublicKey: row.author_public_key,
    verdict: row.verdict, note: row.note, listenedAt: Number(row.listened_at), signature: row.signature,
  };
}

function mapTimedNote(row) {
  return {
    id: Number(row.id), noteUuid: row.note_uuid, demoId: Number(row.demo_id), demoUuid: row.demo_uuid,
    authorId: row.author_id, authorName: row.author_name, authorPublicKey: row.author_public_key,
    startSeconds: Number(row.start_seconds), endSeconds: Number(row.end_seconds), note: row.note,
    createdAt: Number(row.created_at), signature: row.signature,
  };
}

export function getAccount() {
  return publicOwner(database.prepare("SELECT * FROM owner_identity LIMIT 1").get());
}

export function updateAccount({ displayName, peerUrl }) {
  const name = String(displayName ?? "").trim();
  const url = String(peerUrl ?? "").trim().replace(/\/$/, "");
  if (!name) throw new Error("Display name is required");
  if (url && !/^https?:\/\//i.test(url)) throw new Error("Peer URL must begin with http:// or https://");
  database.prepare("UPDATE owner_identity SET display_name = ?, peer_url = ? WHERE id = ?").run(name, url, owner.id);
  owner.display_name = name;
  owner.peer_url = url;
  return getAccount();
}

export function readWorkspace() {
  const projects = listProjects.all();
  const tags = listTags.all().map((row) => ({ name: row.name, createdAt: Number(row.created_at) }));
  const demos = listDemos.all().map(mapDemo);
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
  const listens = listListens.all().map(mapListen);
  const timedNotes = listTimedNotes.all().map(mapTimedNote);
  const friends = listFriends.all().map((row) => ({
    id: row.id, displayName: row.display_name, instanceId: row.instance_id,
    peerUrl: row.peer_url, publicKey: row.public_key, status: row.status,
    createdAt: Number(row.created_at), lastSyncedAt: row.last_synced_at == null ? undefined : Number(row.last_synced_at),
  }));
  const shares = listShares.all().map((row) => ({ demoUuid: row.demo_uuid, friendId: row.friend_id, shareAudio: Boolean(row.share_audio) }));
  return {
    account: getAccount(), friends, shares, projects, tags, demos, orders, media, listens, timedNotes,
    empty: projects.length === 0 && tags.length === 0 && demos.length === 0 && media.length === 0,
  };
}

const insertProject = database.prepare("INSERT INTO projects (name, color, mood, position) VALUES (?, ?, ?, ?)");
const insertTag = database.prepare("INSERT INTO tags (name, created_at) VALUES (?, ?)");
const insertDemo = database.prepare(`
  INSERT INTO demos (id, uuid, owner_id, source_friend_id, title, bpm, musical_key, duration, status, tags_json, note, next_action, rating, favorite, project, updated_at, audio_name, checksum, file_size, copy_verified_at, creation_date, trim_start_seconds, trim_end_seconds)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertTrack = database.prepare("INSERT INTO tracklist (project, demo_id, position) VALUES (?, ?, ?)");
const insertMedia = database.prepare("INSERT INTO project_media (id, project, kind, source, title, note, file_name, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
const insertListen = database.prepare(`
  INSERT INTO listens (id, event_uuid, demo_id, demo_uuid, author_id, author_name, author_public_key, verdict, note, listened_at, signature)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertTimedNote = database.prepare(`
  INSERT INTO timed_notes (id, note_uuid, demo_id, demo_uuid, author_id, author_name, author_public_key, start_seconds, end_seconds, note, created_at, signature)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertShare = database.prepare("INSERT INTO demo_shares (demo_uuid, friend_id, share_audio) VALUES (?, ?, ?)");

function localizeListen(listen, demoById) {
  const demoUuid = listen.demoUuid || demoById.get(Number(listen.demoId))?.uuid;
  const eventUuid = listen.eventUuid || randomUUID();
  const authorId = listen.authorId || owner.id;
  const normalized = {
    ...listen, eventUuid, demoUuid, authorId,
    authorName: listen.authorName || owner.display_name,
    authorPublicKey: listen.authorPublicKey || owner.public_key,
  };
  if (authorId === owner.id) normalized.signature = signListen(normalized);
  return normalized;
}

function localizeTimedNote(note, demoById) {
  const normalized = {
    ...note,
    noteUuid: note.noteUuid || randomUUID(),
    demoUuid: note.demoUuid || demoById.get(Number(note.demoId))?.uuid,
    authorId: note.authorId || owner.id,
    authorName: note.authorName || owner.display_name,
    authorPublicKey: note.authorPublicKey || owner.public_key,
    startSeconds: Math.max(0, Number(note.startSeconds) || 0),
    endSeconds: Math.max(Number(note.startSeconds) || 0, Number(note.endSeconds) || 0),
    createdAt: Number(note.createdAt) || Date.now(),
  };
  if (normalized.authorId === owner.id) normalized.signature = signTimedNote(normalized);
  return normalized;
}

export function writeWorkspace(payload) {
  const projects = Array.isArray(payload.projects) ? payload.projects : [];
  const demos = Array.isArray(payload.demos) ? payload.demos : [];
  const media = Array.isArray(payload.media) ? payload.media : [];
  const listens = Array.isArray(payload.listens) ? payload.listens : [];
  const timedNotes = Array.isArray(payload.timedNotes) ? payload.timedNotes : [];
  const shares = Array.isArray(payload.shares) ? payload.shares : [];
  const orders = payload.orders && typeof payload.orders === "object" ? payload.orders : {};
  const suppliedTags = Array.isArray(payload.tags) ? payload.tags : [];
  const existingUuids = new Map(database.prepare("SELECT id, uuid FROM demos").all().map((row) => [Number(row.id), row.uuid]));
  const normalizedDemos = demos.map((demo) => ({
    ...demo, uuid: demo.uuid || existingUuids.get(Number(demo.id)) || randomUUID(), ownerId: demo.ownerId || owner.id,
  }));
  const demoById = new Map(normalizedDemos.map((demo) => [Number(demo.id), demo]));
  const demoIds = new Set(demoById.keys());
  const demoUuids = new Set(normalizedDemos.map((demo) => demo.uuid));
  const friendIds = new Set(listFriends.all().map((friend) => friend.id));
  const tagMap = new Map();
  for (const tag of suppliedTags) {
    const name = String(tag?.name ?? "").trim();
    if (name) tagMap.set(name.toLocaleLowerCase(), { name, createdAt: Number(tag.createdAt) || Date.now() });
  }
  for (const demo of normalizedDemos) {
    for (const value of Array.isArray(demo.tags) ? demo.tags : []) {
      const name = String(value).trim();
      if (name && !tagMap.has(name.toLocaleLowerCase())) tagMap.set(name.toLocaleLowerCase(), { name, createdAt: Date.now() });
    }
  }
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("DELETE FROM tracklist; DELETE FROM project_media; DELETE FROM demo_shares; DELETE FROM timed_notes; DELETE FROM listens; DELETE FROM demos; DELETE FROM projects; DELETE FROM tags;");
    projects.forEach((project, position) => insertProject.run(project.name, project.color, project.mood ?? "", position));
    for (const tag of tagMap.values()) insertTag.run(tag.name, tag.createdAt);
    normalizedDemos.forEach((demo) => insertDemo.run(
      demo.id, demo.uuid, demo.ownerId, demo.sourceFriendId ?? null, demo.title, demo.bpm || 0, demo.key || "—",
      demo.duration || "00:00", demo.status, JSON.stringify(Array.isArray(demo.tags) ? demo.tags : []), demo.note ?? "",
      demo.nextAction ?? "", demo.rating || 0, demo.favorite ? 1 : 0, demo.project || "Unsorted", demo.updatedAt || Date.now(),
      demo.audioName ?? null, demo.checksum ?? null, demo.fileSize ?? null, demo.copyVerifiedAt ?? null, demo.creationDate ?? null,
      demo.trimStartSeconds ?? null, demo.trimEndSeconds ?? null,
    ));
    media.forEach((item) => insertMedia.run(item.id, item.project, item.kind, item.source, item.title, item.note ?? "", item.fileName ?? null, item.url ?? null, item.createdAt || Date.now()));
    listens.forEach((input) => {
      if (!demoIds.has(Number(input.demoId)) || (input.verdict !== "up" && input.verdict !== "down")) return;
      const listen = localizeListen(input, demoById);
      insertListen.run(listen.id, listen.eventUuid, listen.demoId, listen.demoUuid, listen.authorId, listen.authorName, listen.authorPublicKey, listen.verdict, listen.note ?? "", listen.listenedAt || Date.now(), listen.signature ?? null);
    });
    timedNotes.forEach((input) => {
      if (!demoIds.has(Number(input.demoId)) || !String(input.note ?? "").trim()) return;
      const note = localizeTimedNote(input, demoById);
      insertTimedNote.run(note.id, note.noteUuid, note.demoId, note.demoUuid, note.authorId, note.authorName, note.authorPublicKey, note.startSeconds, note.endSeconds, note.note.trim(), note.createdAt, note.signature ?? null);
    });
    shares.forEach((share) => {
      if (demoUuids.has(share.demoUuid) && friendIds.has(share.friendId)) insertShare.run(share.demoUuid, share.friendId, share.shareAudio === false ? 0 : 1);
    });
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

export function createPairingInvite() {
  if (!owner.peer_url || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(owner.peer_url)) throw new Error("Set this instance's mesh VPN URL before creating an invitation");
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
  database.prepare("INSERT INTO pairing_invites (token, expires_at) VALUES (?, ?)").run(token, expiresAt);
  return Buffer.from(JSON.stringify({ version: 1, peerUrl: owner.peer_url, token }), "utf8").toString("base64url");
}

export function decodePairingInvite(code) {
  try {
    const parsed = JSON.parse(Buffer.from(String(code).trim(), "base64url").toString("utf8"));
    if (parsed.version !== 1 || !parsed.peerUrl || !parsed.token) throw new Error();
    return { peerUrl: String(parsed.peerUrl).replace(/\/$/, ""), token: String(parsed.token) };
  } catch {
    throw new Error("Invalid pairing invitation");
  }
}

export function acceptPairing({ inviteToken, peer, tokenForRemote }) {
  const invitation = database.prepare("SELECT * FROM pairing_invites WHERE token = ?").get(inviteToken);
  if (!invitation || invitation.used_at || Number(invitation.expires_at) < Date.now()) throw new Error("This invitation is invalid or expired");
  if (!peer?.id || !peer?.instanceId || !peer?.publicKey || !peer?.peerUrl || !tokenForRemote) throw new Error("Peer identity is incomplete");
  const tokenForCaller = randomBytes(32).toString("base64url");
  upsertFriend(peer, tokenForCaller, tokenForRemote);
  database.prepare("UPDATE pairing_invites SET used_at = ? WHERE token = ?").run(Date.now(), inviteToken);
  return { account: getAccount(), tokenForCaller };
}

export function upsertFriend(peer, inboundToken, outboundToken) {
  database.prepare(`
    INSERT INTO friends (id, display_name, instance_id, peer_url, public_key, inbound_token, outbound_token, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'connected', ?)
    ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, instance_id = excluded.instance_id,
      peer_url = excluded.peer_url, public_key = excluded.public_key, inbound_token = excluded.inbound_token,
      outbound_token = excluded.outbound_token, status = 'connected'
  `).run(peer.id, peer.displayName, peer.instanceId, String(peer.peerUrl).replace(/\/$/, ""), peer.publicKey, inboundToken, outboundToken, Date.now());
}

export function friendWithSecrets(id) {
  return database.prepare("SELECT * FROM friends WHERE id = ?").get(id);
}

export function authenticatePeer(token) {
  if (!token) return undefined;
  for (const friend of database.prepare("SELECT * FROM friends WHERE status = 'connected'").all()) {
    const expected = Buffer.from(friend.inbound_token);
    const actual = Buffer.from(token);
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) return friend;
  }
  return undefined;
}

function syncDemo(row, friendId) {
  const stored = getStoredFile("audio", Number(row.id));
  const share = database.prepare("SELECT share_audio FROM demo_shares WHERE demo_uuid = ? AND friend_id = ?").get(row.uuid, friendId);
  const demo = mapDemo(row);
  delete demo.id;
  delete demo.project;
  delete demo.note;
  delete demo.nextAction;
  delete demo.favorite;
  delete demo.sourceFriendId;
  return { ...demo, audioAvailable: Boolean(stored && share?.share_audio), audioMimeType: stored?.mime_type };
}

export function buildSyncPackage(friendId) {
  const sharedRows = database.prepare(`
    SELECT demos.* FROM demos JOIN demo_shares ON demo_shares.demo_uuid = demos.uuid
    WHERE demo_shares.friend_id = ? AND demos.owner_id = ?
  `).all(friendId, owner.id);
  const sharedUuids = new Set(sharedRows.map((row) => row.uuid));
  const remoteUuids = new Set(database.prepare("SELECT uuid FROM demos WHERE owner_id = ?").all(friendId).map((row) => row.uuid));
  const listens = listListens.all().map(mapListen).filter((listen) =>
    sharedUuids.has(listen.demoUuid) || (listen.authorId === owner.id && remoteUuids.has(listen.demoUuid)),
  );
  const timedNotes = listTimedNotes.all().map(mapTimedNote).filter((note) =>
    sharedUuids.has(note.demoUuid) || (note.authorId === owner.id && remoteUuids.has(note.demoUuid)),
  );
  return { account: getAccount(), demos: sharedRows.map((row) => syncDemo(row, friendId)), listens, timedNotes };
}

function nextNumericId(table) {
  const maximum = Number(database.prepare(`SELECT COALESCE(MAX(id), 0) AS value FROM ${table}`).get().value);
  return Math.max(Date.now() * 1000 + Math.floor(Math.random() * 1000), maximum + 1);
}

export function mergeSyncPackage(friendId, payload) {
  const friend = friendWithSecrets(friendId);
  if (!friend || payload?.account?.id !== friend.id || payload.account.publicKey !== friend.public_key) throw new Error("Peer identity does not match the paired friend");
  const incomingDemos = Array.isArray(payload.demos) ? payload.demos : [];
  const incomingListens = Array.isArray(payload.listens) ? payload.listens : [];
  const incomingTimedNotes = Array.isArray(payload.timedNotes) ? payload.timedNotes : [];
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const demo of incomingDemos) {
      if (!demo.uuid || demo.ownerId !== friend.id) continue;
      const existing = database.prepare("SELECT * FROM demos WHERE uuid = ?").get(demo.uuid);
      if (existing && existing.owner_id !== friend.id) continue;
      if (existing) {
        database.prepare(`
          UPDATE demos SET title = ?, bpm = ?, musical_key = ?, duration = ?, tags_json = ?, updated_at = ?,
            checksum = ?, file_size = ?, creation_date = ?, trim_start_seconds = ?, trim_end_seconds = ?, source_friend_id = ? WHERE uuid = ?
        `).run(demo.title, demo.bpm || 0, demo.key || "—", demo.duration || "00:00", JSON.stringify(demo.tags ?? []), demo.updatedAt || Date.now(), demo.checksum ?? null, demo.fileSize ?? null, demo.creationDate ?? null, demo.trimStartSeconds ?? null, demo.trimEndSeconds ?? null, friend.id, demo.uuid);
      } else {
        insertDemo.run(nextNumericId("demos"), demo.uuid, friend.id, friend.id, demo.title, demo.bpm || 0, demo.key || "—", demo.duration || "00:00", "unheard", JSON.stringify(demo.tags ?? []), "", "", 0, 0, "Unsorted", demo.updatedAt || Date.now(), null, demo.checksum ?? null, demo.fileSize ?? null, null, demo.creationDate ?? null, demo.trimStartSeconds ?? null, demo.trimEndSeconds ?? null);
      }
    }
    for (const listen of incomingListens) {
      if (!listen.eventUuid || !listen.demoUuid || !listen.authorId || !listen.signature || !listen.authorPublicKey || (listen.verdict !== "up" && listen.verdict !== "down") || !verifyListen(listen)) continue;
      const demo = database.prepare("SELECT id, owner_id FROM demos WHERE uuid = ?").get(listen.demoUuid);
      if (!demo) continue;
      const allowed = demo.owner_id === owner.id
        ? listen.authorId === friend.id && listen.authorPublicKey === friend.public_key
        : demo.owner_id === friend.id;
      if (!allowed) continue;
      database.prepare(`
        INSERT OR IGNORE INTO listens (id, event_uuid, demo_id, demo_uuid, author_id, author_name, author_public_key, verdict, note, listened_at, signature)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(nextNumericId("listens"), listen.eventUuid, demo.id, listen.demoUuid, listen.authorId, listen.authorName || "Friend", listen.authorPublicKey, listen.verdict, listen.note ?? "", listen.listenedAt, listen.signature);
    }
    for (const note of incomingTimedNotes) {
      const startSeconds = Number(note.startSeconds);
      const endSeconds = Number(note.endSeconds);
      if (!note.noteUuid || !note.demoUuid || !note.authorId || !note.signature || !note.authorPublicKey || !String(note.note ?? "").trim() || !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds < startSeconds || !verifyTimedNote(note)) continue;
      const demo = database.prepare("SELECT id, owner_id FROM demos WHERE uuid = ?").get(note.demoUuid);
      if (!demo) continue;
      const allowed = demo.owner_id === owner.id
        ? note.authorId === friend.id && note.authorPublicKey === friend.public_key
        : demo.owner_id === friend.id;
      if (!allowed) continue;
      database.prepare(`
        INSERT OR IGNORE INTO timed_notes (id, note_uuid, demo_id, demo_uuid, author_id, author_name, author_public_key, start_seconds, end_seconds, note, created_at, signature)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(nextNumericId("timed_notes"), note.noteUuid, demo.id, note.demoUuid, note.authorId, note.authorName || "Friend", note.authorPublicKey, startSeconds, endSeconds, note.note.trim(), Number(note.createdAt) || Date.now(), note.signature);
    }
    database.prepare("UPDATE friends SET last_synced_at = ?, status = 'connected' WHERE id = ?").run(Date.now(), friendId);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return incomingDemos.filter((demo) => demo.audioAvailable).map((demo) => demo.uuid);
}

export function demoByUuid(uuid) {
  return database.prepare("SELECT * FROM demos WHERE uuid = ?").get(uuid);
}

export function markPeerAudioStored(demoId, fileName, sizeBytes) {
  database.prepare("UPDATE demos SET audio_name = ?, file_size = ?, copy_verified_at = ? WHERE id = ?")
    .run(fileName, sizeBytes, Date.now(), demoId);
}

export function canFriendAccessAudio(friendId, demoUuid) {
  return Boolean(database.prepare(`
    SELECT 1 FROM demo_shares JOIN demos ON demos.uuid = demo_shares.demo_uuid
    WHERE demo_shares.friend_id = ? AND demo_shares.demo_uuid = ? AND demo_shares.share_audio = 1 AND demos.owner_id = ?
  `).get(friendId, demoUuid, owner.id));
}

export function markFriendSyncError(friendId) {
  database.prepare("UPDATE friends SET status = 'error' WHERE id = ?").run(friendId);
}

export function removeFriend(friendId) {
  database.prepare("DELETE FROM friends WHERE id = ?").run(friendId);
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
