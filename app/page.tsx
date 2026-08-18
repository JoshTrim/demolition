"use client";
/* eslint-disable @next/next/no-img-element -- local blob URLs need native image rendering */

import { useEffect, useMemo, useRef, useState } from "react";

type Status = "unheard" | "revisit" | "shaping" | "finished";
type Demo = {
  id: number;
  uuid: string;
  ownerId: string;
  sourceFriendId?: string;
  title: string;
  bpm: number;
  key: string;
  duration: string;
  status: Status;
  tags: string[];
  note: string;
  nextAction: string;
  rating?: number;
  project: string;
  updatedAt: number;
  audioName?: string;
  checksum?: string;
  fileSize?: number;
  copyVerifiedAt?: number;
  creationDate?: string;
};
type Project = { name: string; color: "coral" | "yellow" | "blue" | "violet"; mood?: string };
type TagDefinition = { name: string; createdAt: number };
type ListenEvent = {
  id: number; eventUuid: string; demoId: number; demoUuid: string; authorId: string;
  authorName: string; authorPublicKey?: string; verdict: "up" | "down"; note: string;
  listenedAt: number; signature?: string;
};
type ListenStats = { up: number; down: number; score: number; count: number; lastAt?: number };
type TimedNote = {
  id: number; noteUuid: string; demoId: number; demoUuid: string; authorId: string;
  authorName: string; authorPublicKey?: string; startSeconds: number; endSeconds: number;
  note: string; createdAt: number; signature?: string;
};
type Account = { id: string; displayName: string; instanceId: string; publicKey: string; peerUrl: string; createdAt: number };
type Friend = { id: string; displayName: string; instanceId: string; peerUrl: string; publicKey: string; status: string; createdAt: number; lastSyncedAt?: number };
type DemoShare = { demoUuid: string; friendId: string; shareAudio: boolean };
type ProjectMedia = {
  id: number;
  project: string;
  kind: "image" | "video" | "audio" | "link";
  source: "file" | "url";
  title: string;
  note: string;
  fileName?: string;
  url?: string;
  createdAt: number;
};
type View = "library" | "revisit" | "project";
type StorageInfo = { usage: number; quota: number; persisted: boolean };

const STORAGE_KEY = "demolition-workspace-clean-v1";
const DB_NAME = "demolition-audio";
const MIGRATION_KEY = "demolition-sqlite-migration-v1";
const initialProjects: Project[] = [];
const day = 86_400_000;
const initialDemos: Demo[] = [];

const statusLabels: Record<Status, string> = { unheard: "Unheard", revisit: "Revisit", shaping: "Shaping", finished: "Finished" };

function apiUrl(path: string) {
  return `http://${window.location.hostname || "localhost"}:3001${path}`;
}

async function loadWorkspace() {
  const response = await fetch(apiUrl("/api/state"));
  if (!response.ok) throw new Error("The local database is unavailable");
  return response.json() as Promise<{ account: Account; friends: Friend[]; shares: DemoShare[]; demos: Demo[]; projects: Project[]; tags: TagDefinition[]; orders: Record<string, number[]>; media: ProjectMedia[]; listens: ListenEvent[]; timedNotes: TimedNote[]; empty: boolean }>;
}

let saveQueue: Promise<void> = Promise.resolve();

function saveWorkspace(payload: { demos: Demo[]; projects: Project[]; tags: TagDefinition[]; orders: Record<string, number[]>; media: ProjectMedia[]; listens: ListenEvent[]; timedNotes: TimedNote[]; shares: DemoShare[] }) {
  const body = JSON.stringify(payload);
  saveQueue = saveQueue.catch(() => undefined).then(async () => {
    const response = await fetch(apiUrl("/api/state"), {
      method: "PUT", headers: { "content-type": "application/json" }, body,
    });
    if (!response.ok) throw new Error("Could not save to the local database");
  });
  return saveQueue;
}

async function apiRequest<T>(path: string, options: RequestInit = {}) {
  const response = await fetch(apiUrl(path), {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "The local server could not complete that request");
  return body as T;
}

async function putStoredFile(type: "audio" | "media", id: number, file: Blob, fileName: string) {
  const response = await fetch(apiUrl(`/api/${type}/${id}`), {
    method: "POST", headers: { "content-type": file.type || "application/octet-stream", "x-file-name": encodeURIComponent(fileName) }, body: file,
  });
  if (!response.ok) throw new Error("Could not copy the file into Demolition's local storage");
}

async function getStoredFile(type: "audio" | "media", id: number): Promise<Blob | undefined> {
  const response = await fetch(apiUrl(`/api/${type}/${id}`));
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error("Could not read the local file copy");
  return response.blob();
}

async function hasStoredFile(type: "audio" | "media", id: number) {
  const response = await fetch(apiUrl(`/api/${type}/${id}`), { method: "HEAD" });
  return response.ok;
}

async function deleteStoredFile(type: "audio" | "media", id: number) {
  const response = await fetch(apiUrl(`/api/${type}/${id}`), { method: "DELETE" });
  if (!response.ok) throw new Error("Could not remove the local file copy");
}

async function putAudio(id: number, file: File) {
  return putStoredFile("audio", id, file, file.name);
}

async function getAudio(id: number) {
  return getStoredFile("audio", id);
}

async function deleteAudioCopy(id: number) {
  return deleteStoredFile("audio", id);
}

async function putProjectMedia(id: number, file: File) {
  return putStoredFile("media", id, file, file.name);
}

async function getProjectMedia(id: number) {
  return getStoredFile("media", id);
}

async function deleteProjectMedia(id: number) {
  return deleteStoredFile("media", id);
}

function openLegacyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("audio")) request.result.createObjectStore("audio");
      if (!request.result.objectStoreNames.contains("project-media")) request.result.createObjectStore("project-media");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getLegacyFile(store: "audio" | "project-media", id: number): Promise<Blob | undefined> {
  const db = await openLegacyDb();
  const result = await new Promise<Blob | undefined>((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return result;
}

async function checksumBlob(blob: Blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 MB";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds)) return "00:00";
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

async function audioDuration(file: File) {
  const url = URL.createObjectURL(file);
  const audio = new Audio(url);
  const duration = await new Promise<number>((resolve) => {
    audio.onloadedmetadata = () => resolve(audio.duration);
    audio.onerror = () => resolve(0);
  });
  URL.revokeObjectURL(url);
  return formatDuration(duration);
}

async function analyzeAudio(file: Blob): Promise<{ duration: string; bpm: number }> {
  const AudioContextClass = window.AudioContext;
  const context = new AudioContextClass();
  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    const hop = 1024;
    const frameCount = Math.floor(buffer.length / hop);
    const envelope = new Float32Array(frameCount);
    for (let frame = 0; frame < frameCount; frame++) {
      const start = frame * hop;
      let energy = 0;
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const samples = buffer.getChannelData(channel);
        for (let index = start; index < Math.min(start + hop, buffer.length); index += 4) energy += samples[index] * samples[index];
      }
      envelope[frame] = Math.sqrt(energy / Math.max(1, buffer.numberOfChannels * hop / 4));
    }
    const onset = new Float32Array(frameCount);
    let average = 0;
    for (let index = 1; index < frameCount; index++) {
      const rise = Math.max(0, envelope[index] - envelope[index - 1] * 0.92);
      average = average * 0.98 + rise * 0.02;
      onset[index] = rise > average * 1.35 ? rise : 0;
    }
    const envelopeRate = buffer.sampleRate / hop;
    let bestBpm = 0;
    let bestScore = 0;
    for (let bpm = 60; bpm <= 190; bpm++) {
      const lag = Math.round(envelopeRate * 60 / bpm);
      let score = 0;
      for (let index = lag; index < onset.length; index++) score += onset[index] * onset[index - lag];
      const halfLag = Math.round(lag / 2);
      if (halfLag > 1) for (let index = halfLag; index < onset.length; index++) score += onset[index] * onset[index - halfLag] * 0.18;
      if (score > bestScore) { bestScore = score; bestBpm = bpm; }
    }
    if (bestBpm && bestBpm < 75) bestBpm *= 2;
    return { duration: formatDuration(buffer.duration), bpm: bestScore > 0 ? Math.round(bestBpm) : 0 };
  } catch {
    return { duration: file instanceof File ? await audioDuration(file) : "00:00", bpm: 0 };
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function waveformPeaks(file: Blob, barCount = 160) {
  const context = new window.AudioContext();
  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    const peaks = Array.from({ length: barCount }, () => 0);
    const samplesPerBar = Math.max(1, Math.floor(buffer.length / barCount));
    let overallPeak = 0;
    for (let bar = 0; bar < barCount; bar++) {
      const start = bar * samplesPerBar;
      const end = Math.min(buffer.length, start + samplesPerBar);
      let peak = 0;
      const stride = Math.max(1, Math.floor((end - start) / 180));
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const samples = buffer.getChannelData(channel);
        for (let index = start; index < end; index += stride) peak = Math.max(peak, Math.abs(samples[index]));
      }
      peaks[bar] = peak;
      overallPeak = Math.max(overallPeak, peak);
    }
    return peaks.map((peak) => Math.max(0.08, overallPeak ? peak / overallPeak : 0.08));
  } catch {
    return [];
  } finally {
    await context.close().catch(() => undefined);
  }
}

function relativeDate(timestamp: number) {
  const days = Math.max(0, Math.floor((Date.now() - timestamp) / day));
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

function validIsoDate(year: number, month: number, dayOfMonth: number) {
  if (year < 1990 || year > new Date().getFullYear() + 1) return undefined;
  const date = new Date(Date.UTC(year, month - 1, dayOfMonth));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== dayOfMonth) return undefined;
  return `${year}-${String(month).padStart(2, "0")}-${String(dayOfMonth).padStart(2, "0")}`;
}

function extractCreationDate(title: string) {
  const yearFirst = title.match(/(?:^|\D)((?:19|20)\d{2})[-_. ]?(0?[1-9]|1[0-2])[-_. ]?([0-2]?\d|3[01])(?:\D|$)/);
  if (yearFirst) return validIsoDate(Number(yearFirst[1]), Number(yearFirst[2]), Number(yearFirst[3]));
  const dayFirst = title.match(/(?:^|\D)([0-2]?\d|3[01])[-_. ](0?[1-9]|1[0-2])[-_. ]((?:19|20)\d{2})(?:\D|$)/);
  if (dayFirst) return validIsoDate(Number(dayFirst[3]), Number(dayFirst[2]), Number(dayFirst[1]));
  const shortYearDayFirst = title.match(/(?:^|\D)([0-2]?\d|3[01])[-_. ](0?[1-9]|1[0-2])[-_. ](\d{2})(?:\D|$)/);
  if (shortYearDayFirst) {
    const shortYear = Number(shortYearDayFirst[3]);
    const fullYear = shortYear >= 80 ? 1900 + shortYear : 2000 + shortYear;
    return validIsoDate(fullYear, Number(shortYearDayFirst[2]), Number(shortYearDayFirst[1]));
  }
  const compactDayFirst = title.match(/(?:^|\D)([0-2]\d|3[01])(0[1-9]|1[0-2])((?:19|20)\d{2})(?:\D|$)/);
  if (compactDayFirst) return validIsoDate(Number(compactDayFirst[3]), Number(compactDayFirst[2]), Number(compactDayFirst[1]));
  return undefined;
}

function formatCreationDate(iso?: string) {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
}

function parseTags(value: string) {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const part of value.split(",")) {
    const name = part.trim().replace(/^#+/, "").slice(0, 40);
    const key = name.toLocaleLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    tags.push(name);
  }
  return tags;
}

function mergeTags(current: TagDefinition[], names: string[]) {
  const next = [...current];
  const known = new Set(current.map((tag) => tag.name.toLocaleLowerCase()));
  for (const name of names) {
    const key = name.toLocaleLowerCase();
    if (!known.has(key)) {
      known.add(key);
      next.push({ name, createdAt: Date.now() });
    }
  }
  return next.sort((a, b) => a.name.localeCompare(b.name));
}

export default function Home() {
  const [demos, setDemos] = useState(initialDemos);
  const [projects, setProjects] = useState(initialProjects);
  const [tags, setTags] = useState<TagDefinition[]>([]);
  const [media, setMedia] = useState<ProjectMedia[]>([]);
  const [listens, setListens] = useState<ListenEvent[]>([]);
  const [timedNotes, setTimedNotes] = useState<TimedNote[]>([]);
  const [account, setAccount] = useState<Account>();
  const [friends, setFriends] = useState<Friend[]>([]);
  const [shares, setShares] = useState<DemoShare[]>([]);
  const [mediaUrls, setMediaUrls] = useState<Record<number, string>>({});
  const [orders, setOrders] = useState<Record<string, number[]>>({});
  const [view, setView] = useState<View>("library");
  const [project, setProject] = useState("All demos");
  const [filter, setFilter] = useState("All");
  const [tagFilter, setTagFilter] = useState("All tags");
  const [selectedId, setSelectedId] = useState(1);
  const [showAdd, setShowAdd] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const [bulkProgress, setBulkProgress] = useState("");
  const [showBulkDetect, setShowBulkDetect] = useState(false);
  const [detectProgress, setDetectProgress] = useState("");
  const [showStorage, setShowStorage] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const [pairingCode, setPairingCode] = useState("");
  const [meshProgress, setMeshProgress] = useState("");
  const [storageInfo, setStorageInfo] = useState<StorageInfo>({ usage: 0, quota: 0, persisted: false });
  const [storageProgress, setStorageProgress] = useState("");
  const [rapidMode, setRapidMode] = useState(false);
  const [rapidIndex, setRapidIndex] = useState(0);
  const [rapidIds, setRapidIds] = useState<number[]>([]);
  const [rapidNote, setRapidNote] = useState("");
  const [rapidVote, setRapidVote] = useState<"up" | "down">();
  const [rapidVoteEventUuid, setRapidVoteEventUuid] = useState<string>();
  const [rapidDuration, setRapidDuration] = useState(0);
  const [rapidCurrentTime, setRapidCurrentTime] = useState(0);
  const [detailCurrentTime, setDetailCurrentTime] = useState(0);
  const [waveform, setWaveform] = useState<number[]>([]);
  const [timedNoteRange, setTimedNoteRange] = useState<{ start: number; end: number }>();
  const [timedNoteDraft, setTimedNoteDraft] = useState("");
  const [editingTimedNoteUuid, setEditingTimedNoteUuid] = useState<string>();
  const [importNotice, setImportNotice] = useState("");
  const [detectingId, setDetectingId] = useState<number>();
  const [showEdit, setShowEdit] = useState(false);
  const [editTagsDraft, setEditTagsDraft] = useState("");
  const [showProject, setShowProject] = useState(false);
  const [showTags, setShowTags] = useState(false);
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [showMedia, setShowMedia] = useState(false);
  const [projectTab, setProjectTab] = useState<"tracklist" | "moodboard">("tracklist");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"score" | "updated" | "created-new" | "created-old" | "title">("updated");
  const [audioUrl, setAudioUrl] = useState<string>();
  const [ready, setReady] = useState(false);
  const [draggedId, setDraggedId] = useState<number>();
  const importRef = useRef<HTMLInputElement>(null);
  const attachRef = useRef<HTMLInputElement>(null);
  const detailAudioRef = useRef<HTMLAudioElement>(null);
  const rapidAudioRef = useRef<HTMLAudioElement>(null);
  const annotationRailRef = useRef<HTMLDivElement>(null);
  const annotationDragStartRef = useRef<number | undefined>(undefined);
  const waveformCacheRef = useRef(new Map<string, number[]>());
  const rapidActionsRef = useRef({ previous: () => undefined, next: () => undefined, down: () => undefined, up: () => undefined });

  async function refreshStorageInfo() {
    const response = await fetch(apiUrl("/api/storage"));
    if (!response.ok) throw new Error("Could not read local storage information");
    setStorageInfo(await response.json());
  }

  useEffect(() => {
    let active = true;
    async function initialize() {
      try {
        const serverData = await loadWorkspace();
        let data = serverData;
        const saved = localStorage.getItem(STORAGE_KEY);
        const migrationComplete = localStorage.getItem(MIGRATION_KEY) === "complete";
        if (saved && !migrationComplete) {
          const legacy = JSON.parse(saved) as Partial<typeof serverData>;
          const legacyData = {
            demos: Array.isArray(legacy.demos) ? legacy.demos.map((demo) => ({ ...demo, creationDate: demo.creationDate || extractCreationDate(demo.title) })) : [],
            projects: Array.isArray(legacy.projects) ? legacy.projects : [],
            tags: Array.isArray(legacy.tags) ? legacy.tags : [],
            media: Array.isArray(legacy.media) ? legacy.media : [],
            listens: Array.isArray(legacy.listens) ? legacy.listens : [],
            timedNotes: Array.isArray(legacy.timedNotes) ? legacy.timedNotes : [],
            shares: Array.isArray(legacy.shares) ? legacy.shares : [],
            orders: legacy.orders && typeof legacy.orders === "object" ? legacy.orders : {},
          };
          legacyData.tags = mergeTags(legacyData.tags, legacyData.demos.flatMap((demo) => demo.tags));
          if (serverData.empty && (legacyData.demos.length || legacyData.projects.length || legacyData.media.length)) {
            await saveWorkspace(legacyData);
            data = await loadWorkspace();
          }
          let migrationFailures = 0;
          if (!data.empty) {
            for (const demo of data.demos) {
              if (!demo.audioName) continue;
              if (await hasStoredFile("audio", demo.id)) continue;
              const blob = await getLegacyFile("audio", demo.id).catch(() => undefined);
              if (blob) await putStoredFile("audio", demo.id, blob, demo.audioName).catch(() => { migrationFailures++; });
            }
            for (const item of data.media) {
              if (item.source !== "file" || !item.fileName) continue;
              if (await hasStoredFile("media", item.id)) continue;
              const blob = await getLegacyFile("project-media", item.id).catch(() => undefined);
              if (blob) await putStoredFile("media", item.id, blob, item.fileName).catch(() => { migrationFailures++; });
            }
          }
          if (migrationFailures === 0) {
            localStorage.setItem(MIGRATION_KEY, "complete");
            if (!data.empty) setImportNotice("Existing browser data was copied into the local SQLite library.");
          } else {
            setImportNotice(`${migrationFailures} existing ${migrationFailures === 1 ? "file" : "files"} could not be copied. Reload to retry.`);
          }
        }
        if (!active) return;
        setDemos(data.demos);
        setProjects(data.projects);
        setTags(mergeTags(data.tags ?? [], data.demos.flatMap((demo) => demo.tags)));
        setMedia(data.media);
        setListens(data.listens ?? []);
        setTimedNotes(data.timedNotes ?? []);
        setAccount(data.account);
        setFriends(data.friends ?? []);
        setShares(data.shares ?? []);
        setOrders(data.orders);
        setSelectedId(data.demos[0]?.id ?? 1);
        setReady(true);
        await refreshStorageInfo();
      } catch {
        if (active) window.alert("Demolition could not connect to its local SQLite backend. Restart the local server and reload this page.");
      }
    }
    initialize();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const timeout = window.setTimeout(() => {
      saveWorkspace({ demos, projects, tags, orders, media, listens, timedNotes, shares }).catch(() => {
        setImportNotice("Changes could not be saved to SQLite. Check that the local server is running.");
      });
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [demos, projects, tags, orders, media, listens, timedNotes, shares, ready]);

  useEffect(() => {
    let currentUrl: string | undefined;
    let active = true;
    getAudio(selectedId).then((blob) => {
      if (blob && active) {
        setDetailCurrentTime(0);
        currentUrl = URL.createObjectURL(blob);
        setAudioUrl(currentUrl);
        const demo = demos.find((item) => item.id === selectedId);
        const cacheKey = demo?.checksum || `${selectedId}:${blob.size}`;
        const cached = waveformCacheRef.current.get(cacheKey);
        if (cached) setWaveform(cached);
        else {
          setWaveform([]);
          waveformPeaks(blob).then((peaks) => {
            if (!active) return;
            waveformCacheRef.current.set(cacheKey, peaks);
            setWaveform(peaks);
          });
        }
      } else if (active) {
        setAudioUrl(undefined);
        setWaveform([]);
        setDetailCurrentTime(0);
      }
    }).catch(() => { if (active) setWaveform([]); });
    return () => { active = false; if (currentUrl) URL.revokeObjectURL(currentUrl); };
  }, [selectedId, demos]);

  useEffect(() => {
    if (rapidMode && audioUrl) rapidAudioRef.current?.play().catch(() => undefined);
  }, [audioUrl, rapidMode]);

  useEffect(() => {
    if (!rapidMode || !editingTimedNoteUuid || !audioUrl) return;
    const note = timedNotes.find((item) => item.noteUuid === editingTimedNoteUuid);
    const player = rapidAudioRef.current;
    if (note && player && player.readyState >= 1) player.currentTime = note.startSeconds;
  }, [audioUrl, editingTimedNoteUuid, rapidDuration, rapidMode, timedNotes]);

  useEffect(() => {
    if (!rapidMode) return;
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "SELECT" || event.repeat) return;
      const key = event.key.toLowerCase();
      const action = key === "arrowleft" || key === "h" ? rapidActionsRef.current.previous
        : key === "arrowright" || key === "l" ? rapidActionsRef.current.next
        : key === "arrowdown" || key === "j" ? rapidActionsRef.current.down
        : key === "arrowup" || key === "k" ? rapidActionsRef.current.up : undefined;
      if (action) { event.preventDefault(); action(); }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [rapidMode]);

  useEffect(() => {
    if (view !== "project" || projectTab !== "moodboard") return;
    let active = true;
    const localItems = media.filter((item) => item.project === project && item.source === "file");
    Promise.all(localItems.map(async (item) => ({ id: item.id, blob: await getProjectMedia(item.id) }))).then((items) => {
      if (!active) return;
      const urls: Record<number, string> = {};
      for (const item of items) if (item.blob) urls[item.id] = URL.createObjectURL(item.blob);
      setMediaUrls(urls);
    }).catch(() => undefined);
    return () => {
      active = false;
      setMediaUrls((current) => { Object.values(current).forEach((url) => URL.revokeObjectURL(url)); return {}; });
    };
  }, [media, project, projectTab, view]);

  const listenStats = useMemo(() => {
    const stats = new Map<number, ListenStats>();
    for (const listen of listens) {
      const current = stats.get(listen.demoId) ?? { up: 0, down: 0, score: 0, count: 0 };
      if (listen.verdict === "up") current.up++;
      else current.down++;
      current.score = current.up - current.down;
      current.count++;
      current.lastAt = Math.max(current.lastAt ?? 0, listen.listenedAt);
      stats.set(listen.demoId, current);
    }
    return stats;
  }, [listens]);
  const statsFor = (demoId: number) => listenStats.get(demoId) ?? { up: 0, down: 0, score: 0, count: 0 };
  const selected = demos.find((demo) => demo.id === selectedId) ?? demos[0];
  const revisitDemos = useMemo(() => demos.filter((demo) => demo.status === "revisit" || demo.status === "unheard").sort((a, b) => a.updatedAt - b.updatedAt), [demos]);
  const inProjects = demos.filter((demo) => demo.project !== "Unsorted").length;
  const projectNames = [...projects.map((item) => item.name), "Unsorted"];
  const currentProject = projects.find((item) => item.name === project);
  const projectMedia = media.filter((item) => item.project === project).sort((a, b) => b.createdAt - a.createdAt);
  const projectOrder = orders[project] ?? [];
  const projectCandidates = demos.filter((demo) => demo.project === project && !projectOrder.includes(demo.id));
  const rapidDemo = demos.find((demo) => demo.id === rapidIds[rapidIndex]);
  const selectedStats = selected ? statsFor(selected.id) : statsFor(0);
  const selectedListens = selected ? listens.filter((listen) => listen.demoId === selected.id).slice(0, 5) : [];
  const selectedTimedNotes = selected ? timedNotes.filter((note) => note.demoId === selected.id).sort((a, b) => a.startSeconds - b.startSeconds) : [];
  const selectedOwnerScore = selected && account ? listens.filter((listen) => listen.demoId === selected.id && listen.authorId === account.id).reduce((score, listen) => score + (listen.verdict === "up" ? 1 : -1), 0) : 0;
  const selectedFriendScore = selected && account ? listens.filter((listen) => listen.demoId === selected.id && listen.authorId !== account.id).reduce((score, listen) => score + (listen.verdict === "up" ? 1 : -1), 0) : 0;
  const rapidStats = rapidDemo ? statsFor(rapidDemo.id) : statsFor(0);
  const rapidTimedNotes = rapidDemo ? timedNotes.filter((note) => note.demoId === rapidDemo.id).sort((a, b) => a.startSeconds - b.startSeconds) : [];
  const selectedActiveNoteUuids = new Set(selectedTimedNotes.filter((note) => detailCurrentTime >= note.startSeconds && detailCurrentTime <= note.endSeconds).map((note) => note.noteUuid));
  const rapidActiveNoteUuids = new Set(rapidTimedNotes.filter((note) => rapidCurrentTime >= note.startSeconds && rapidCurrentTime <= note.endSeconds).map((note) => note.noteUuid));
  const rapidDownSelected = rapidVote === "down";
  const rapidUpSelected = rapidVote === "up";
  const selectedListenHistory = selectedListens.length > 0 ? <div className="listen-history"><span className="eyebrow">RECENT LISTENS</span>{selectedListens.map((listen) => <div className={`listen-event ${listen.verdict}`} key={listen.eventUuid || listen.id}><b>{listen.verdict === "up" ? "↑" : "↓"}</b><span><i>{listen.authorId === account?.id ? "You" : listen.authorName}</i>{listen.note || "No note"}<small>{new Date(listen.listenedAt).toLocaleDateString("en-AU")}</small></span></div>)}</div> : null;
  const selectedTimedNoteHistory = selectedTimedNotes.length > 0 ? <div className="timed-note-history"><span className="eyebrow">TIMED NOTES</span>{selectedTimedNotes.map((note) => <div className={`timed-note-history-row ${selectedActiveNoteUuids.has(note.noteUuid) ? "active" : ""}`} key={note.noteUuid}><button className="timed-note-jump" onClick={() => seekTimedNote(note)}><b>{formatDuration(note.startSeconds)}–{formatDuration(note.endSeconds)}</b><span><i>{note.authorId === account?.id ? "You" : note.authorName}</i>{note.note}</span></button>{note.authorId === account?.id && <div className="timed-note-actions"><button onClick={() => editTimedNote(note)}>Edit</button><button onClick={() => deleteTimedNote(note)}>Delete</button></div>}</div>)}</div> : null;
  const selectedSharing = selected && account ? selected.ownerId === account.id
    ? <div className="detail-section sharing-section"><div className="detail-section-head"><span>SHARED WITH</span><button onClick={() => setShowAccount(true)}>manage</button></div><div className="share-friends">{friends.map((friend) => { const active = shares.some((share) => share.demoUuid === selected.uuid && share.friendId === friend.id); return <button key={friend.id} className={active ? "shared" : ""} onClick={() => toggleDemoShare(selected, friend.id)}><span>{active ? "✓" : "+"}</span>{friend.displayName}</button>; })}{friends.length === 0 && <small>No friends connected.</small>}</div></div>
    : <div className="detail-section remote-source"><div className="detail-section-head"><span>SHARED BY</span></div><p>{friends.find((friend) => friend.id === selected.ownerId)?.displayName || "Friend"}</p></div> : null;
  const rapidAnnotationTransport = audioUrl ? (
    <section className="annotation-transport">
      <div className="annotation-head"><span>TIMED NOTES</span><small>Drag across the waveform to select a range</small></div>
      <div
        ref={annotationRailRef}
        className={`annotation-rail ${rapidDuration ? "ready" : ""}`}
        aria-label="Drag across the waveform to select a timed note range"
        onPointerDown={beginTimedNoteRange}
        onPointerMove={moveTimedNoteRange}
        onPointerUp={finishTimedNoteRange}
        onPointerCancel={() => { annotationDragStartRef.current = undefined; }}
      >
        <span className="annotation-progress" style={{ width: `${rapidDuration ? rapidCurrentTime / rapidDuration * 100 : 0}%` }} />
        <span className="annotation-waveform" aria-hidden="true">
          {waveform.map((peak, index) => <i key={index} style={{ height: `${Math.max(2, peak * 100)}%` }} />)}
        </span>
        {rapidTimedNotes.map((note) => <i
          key={note.noteUuid}
          className={`saved-range ${rapidActiveNoteUuids.has(note.noteUuid) ? "active" : ""}`}
          style={{
            left: `${rapidDuration ? note.startSeconds / rapidDuration * 100 : 0}%`,
            width: `${rapidDuration ? Math.max(0.7, (note.endSeconds - note.startSeconds) / rapidDuration * 100) : 0}%`,
          }}
          title={`${formatDuration(note.startSeconds)}–${formatDuration(note.endSeconds)} · ${note.note}`}
        />)}
        {timedNoteRange && <i className="draft-range" style={{
          left: `${timedNoteRange.start / rapidDuration * 100}%`,
          width: `${Math.max(0.7, (timedNoteRange.end - timedNoteRange.start) / rapidDuration * 100)}%`,
        }} />}
      </div>
      <div className="annotation-times"><span>{formatDuration(rapidCurrentTime)}</span><span>{formatDuration(rapidDuration)}</span></div>
      {timedNoteRange && <form className="timed-note-editor" onSubmit={saveTimedNote}>
        <div><b>{editingTimedNoteUuid ? "EDIT " : ""}{formatDuration(timedNoteRange.start)}–{formatDuration(timedNoteRange.end)}</b><button type="button" onClick={cancelTimedNoteEdit}>Cancel</button></div>
        <textarea value={timedNoteDraft} onChange={(event) => setTimedNoteDraft(event.target.value)} rows={2} placeholder="What applies to this section?" />
        <button type="submit" disabled={!timedNoteDraft.trim()}>{editingTimedNoteUuid ? "Update timed note" : "Save timed note"}</button>
      </form>}
      {rapidTimedNotes.length > 0 && <div className="rapid-timed-notes">
        {rapidTimedNotes.map((note) => <div className={`rapid-timed-note-row ${rapidActiveNoteUuids.has(note.noteUuid) ? "active" : ""}`} key={note.noteUuid}>
          <button className="timed-note-jump" onClick={() => seekTimedNote(note)}><b>{formatDuration(note.startSeconds)}–{formatDuration(note.endSeconds)}</b><span>{note.note}</span><small>{note.authorId === account?.id ? "You" : note.authorName}</small></button>
          {note.authorId === account?.id && <div className="timed-note-actions"><button onClick={() => editTimedNote(note)}>Edit</button><button onClick={() => deleteTimedNote(note)}>Delete</button></div>}
        </div>)}
      </div>}
    </section>
  ) : null;
  const storagePercent = storageInfo.quota ? Math.min(100, storageInfo.usage / storageInfo.quota * 100) : 0;

  const visibleDemos = useMemo(() => {
    let result = demos.filter((demo) => {
      const projectMatch = project === "All demos" || demo.project === project;
      const filterMatch = filter === "All" || statusLabels[demo.status] === filter;
      const searchMatch = `${demo.title} ${demo.tags.join(" ")}`.toLowerCase().includes(search.toLowerCase());
      const tagMatch = tagFilter === "All tags" || demo.tags.some((tag) => tag.toLocaleLowerCase() === tagFilter.toLocaleLowerCase());
      const revisitMatch = view !== "revisit" || demo.status === "revisit" || demo.status === "unheard";
      return projectMatch && filterMatch && tagMatch && searchMatch && revisitMatch;
    });
    if (view === "revisit") return result.sort((a, b) => a.updatedAt - b.updatedAt);
    if (view === "project" && project !== "All demos") {
      const order = orders[project] ?? [];
      if (project !== "Unsorted") result = result.filter((demo) => order.includes(demo.id));
      result = [...result].sort((a, b) => {
        const ai = order.indexOf(a.id);
        const bi = order.indexOf(b.id);
        return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
      });
    } else if (view !== "revisit") {
      result = [...result].sort((a, b) => {
        if (sortBy === "score") {
          const aStats = listenStats.get(a.id) ?? { up: 0, down: 0, score: 0, count: 0 };
          const bStats = listenStats.get(b.id) ?? { up: 0, down: 0, score: 0, count: 0 };
          return bStats.score - aStats.score || bStats.up - aStats.up || aStats.down - bStats.down || a.title.localeCompare(b.title);
        }
        if (sortBy === "title") return a.title.localeCompare(b.title);
        if (sortBy === "updated") return b.updatedAt - a.updatedAt;
        const aDate = a.creationDate ? Date.parse(`${a.creationDate}T00:00:00Z`) : undefined;
        const bDate = b.creationDate ? Date.parse(`${b.creationDate}T00:00:00Z`) : undefined;
        if (aDate === undefined && bDate === undefined) return a.title.localeCompare(b.title);
        if (aDate === undefined) return 1;
        if (bDate === undefined) return -1;
        return sortBy === "created-old" ? aDate - bDate : bDate - aDate;
      });
    }
    return result;
  }, [demos, project, filter, tagFilter, search, view, orders, sortBy, listenStats]);

  function selectProject(name: string) {
    setProject(name);
    setView(name === "All demos" ? "library" : "project");
    setFilter("All");
    setProjectTab("tracklist");
  }

  function openEdit() {
    if (!selected) return;
    setEditTagsDraft(selected.tags.join(", "));
    setShowEdit(true);
  }

  function toggleEditTag(name: string) {
    setEditTagsDraft((current) => {
      const currentTags = parseTags(current);
      const next = currentTags.some((tag) => tag.toLocaleLowerCase() === name.toLocaleLowerCase())
        ? currentTags.filter((tag) => tag.toLocaleLowerCase() !== name.toLocaleLowerCase())
        : [...currentTags, name];
      return next.join(", ");
    });
  }

  async function addDemo(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const file = form.get("audio");
    const id = Date.now();
    const hasFile = file instanceof File && file.size > 0;
    const checksum = hasFile ? await checksumBlob(file) : undefined;
    if (checksum && demos.some((demo) => demo.checksum === checksum)) { window.alert("This audio file is already in Demolition."); return; }
    if (hasFile && storageInfo.quota && file.size > storageInfo.quota - storageInfo.usage) { window.alert("There is not enough disk space available for this copy."); return; }
    const analysis = hasFile ? await analyzeAudio(file) : { duration: "00:00", bpm: 0 };
    const title = String(form.get("title") || (hasFile ? file.name.replace(/\.[^.]+$/, "") : "Untitled demo"));
    const demoTags = parseTags(String(form.get("tags") || ""));
    const next: Demo = {
      id,
      uuid: crypto.randomUUID(),
      ownerId: account?.id ?? "",
      title,
      bpm: Number(form.get("bpm") || analysis.bpm),
      key: String(form.get("key") || "C maj"),
      duration: analysis.duration,
      status: "unheard",
      tags: demoTags,
      note: "",
      nextAction: "First proper listen",
      rating: 0,
      project: String(form.get("project") || "Unsorted"),
      updatedAt: Date.now(),
      audioName: hasFile ? file.name : undefined,
      checksum,
      fileSize: hasFile ? file.size : undefined,
      copyVerifiedAt: hasFile ? Date.now() : undefined,
      creationDate: extractCreationDate(hasFile ? file.name : title),
    };
    if (hasFile) await putAudio(id, file);
    setTags((current) => mergeTags(current, demoTags));
    setDemos((current) => [next, ...current]);
    setSelectedId(id);
    setProject("All demos");
    setView("library");
    setShowAdd(false);
    refreshStorageInfo().catch(() => undefined);
  }

  function editDemo(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const previousProject = selected.project;
    const nextProject = String(form.get("project"));
    const nextTags = parseTags(editTagsDraft);
    setTags((current) => mergeTags(current, nextTags));
    setDemos((current) => current.map((demo) => demo.id === selected.id ? {
      ...demo,
      title: String(form.get("title")), bpm: Number(form.get("bpm")), key: String(form.get("key")),
      creationDate: String(form.get("creationDate") || "") || undefined,
      status: String(form.get("status")) as Status, project: nextProject,
      tags: nextTags,
      note: String(form.get("note")), nextAction: String(form.get("nextAction")),
      updatedAt: Date.now(),
    } : demo));
    if (previousProject !== nextProject) setOrders((current) => ({
      ...current,
      [previousProject]: (current[previousProject] ?? []).filter((id) => id !== selected.id),
      [nextProject]: (current[nextProject] ?? []).filter((id) => id !== selected.id),
    }));
    setShowEdit(false);
  }

  async function attachAudio(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const checksum = await checksumBlob(file);
    if (demos.some((demo) => demo.id !== selected.id && demo.checksum === checksum)) { window.alert("This audio is already attached to another demo."); return; }
    await putAudio(selected.id, file);
    const analysis = await analyzeAudio(file);
    setDemos((current) => current.map((demo) => demo.id === selected.id ? { ...demo, audioName: file.name, duration: analysis.duration, bpm: analysis.bpm || demo.bpm, checksum, fileSize: file.size, copyVerifiedAt: Date.now(), updatedAt: Date.now() } : demo));
    refreshStorageInfo().catch(() => undefined);
    event.target.value = "";
  }

  async function bulkImport(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const destination = String(form.get("project") || "Unsorted");
    const batchTags = parseTags(String(form.get("tags") || ""));
    const candidates = [...form.getAll("files"), ...form.getAll("folder")].filter((item): item is File => item instanceof File && item.size > 0);
    const audioFiles = candidates.filter((file) => file.type.startsWith("audio/") || /\.(wav|aif|aiff|mp3|m4a|flac|ogg|opus|aac)$/i.test(file.name));
    const skippedFiles = candidates.length - audioFiles.length;
    if (!audioFiles.length) { setBulkProgress(`No supported audio files found. ${skippedFiles} other ${skippedFiles === 1 ? "file was" : "files were"} ignored.`); return; }
    const totalBytes = audioFiles.reduce((sum, file) => sum + file.size, 0);
    if (storageInfo.quota && totalBytes > (storageInfo.quota - storageInfo.usage) * 0.95) { setBulkProgress(`Not enough storage. This import needs ${formatBytes(totalBytes)}, but about ${formatBytes(Math.max(0, storageInfo.quota - storageInfo.usage))} is available.`); return; }
    const imported: Demo[] = [];
    const knownChecksums = new Set(demos.map((demo) => demo.checksum).filter(Boolean));
    let duplicates = 0;
    for (let index = 0; index < audioFiles.length; index++) {
      const file = audioFiles[index];
      setBulkProgress(`Checking ${index + 1} of ${audioFiles.length}: ${file.name}`);
      const checksum = await checksumBlob(file);
      if (knownChecksums.has(checksum)) { duplicates++; continue; }
      knownChecksums.add(checksum);
      setBulkProgress(`Analyzing ${index + 1} of ${audioFiles.length}: ${file.name}`);
      const id = Date.now() + index;
      const analysis = await analyzeAudio(file);
      await putAudio(id, file);
      const title = file.name.replace(/\.[^.]+$/, "");
      imported.push({
        id, uuid: crypto.randomUUID(), ownerId: account?.id ?? "", title, bpm: analysis.bpm, key: "—", duration: analysis.duration,
        status: "unheard", tags: batchTags, note: "", nextAction: "First proper listen",
        rating: 0, project: destination, updatedAt: Date.now(), audioName: file.name,
        checksum, fileSize: file.size, copyVerifiedAt: Date.now(),
        creationDate: extractCreationDate(title),
      });
    }
    if (!imported.length) { setBulkProgress(`Nothing new to import. ${duplicates} duplicate ${duplicates === 1 ? "file was" : "files were"} skipped.`); return; }
    setTags((current) => mergeTags(current, batchTags));
    setDemos((current) => [...imported, ...current]);
    setSelectedId(imported[0].id);
    setProject(destination === "Unsorted" ? "All demos" : destination);
    setView(destination === "Unsorted" ? "library" : "project");
    setProjectTab("tracklist");
    setImportNotice(`${imported.length} audio ${imported.length === 1 ? "file" : "files"} imported${duplicates ? ` · ${duplicates} duplicate ${duplicates === 1 ? "file" : "files"} skipped` : ""}${skippedFiles ? ` · ${skippedFiles} non-audio ${skippedFiles === 1 ? "file" : "files"} ignored` : ""}.`);
    setBulkProgress("");
    setShowBulk(false);
    refreshStorageInfo().catch(() => undefined);
  }

  async function detectSelectedBpm() {
    setDetectingId(selected.id);
    try {
      const blob = await getAudio(selected.id);
      if (!blob) { window.alert("Attach an audio bounce before detecting BPM."); return; }
      const analysis = await analyzeAudio(blob);
      setDemos((current) => current.map((demo) => demo.id === selected.id ? { ...demo, bpm: analysis.bpm, duration: analysis.duration, updatedAt: Date.now() } : demo));
      if (!analysis.bpm) window.alert("Demolition could not find a steady tempo. You can enter the BPM manually.");
    } finally { setDetectingId(undefined); }
  }

  async function bulkDetectBpm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const scope = String(form.get("scope") || "library");
    const mode = String(form.get("mode") || "missing");
    let targets = demos.filter((demo) => scope === "library" || demo.project === project);
    if (mode === "missing") targets = targets.filter((demo) => !demo.bpm);
    if (!targets.length) { setDetectProgress("No demos match this selection."); return; }
    let detected = 0;
    let noAudio = 0;
    let uncertain = 0;
    for (let index = 0; index < targets.length; index++) {
      const demo = targets[index];
      setDetectProgress(`Analyzing ${index + 1} of ${targets.length}: ${demo.title}`);
      const blob = await getAudio(demo.id).catch(() => undefined);
      if (!blob) { noAudio++; continue; }
      const analysis = await analyzeAudio(blob);
      if (!analysis.bpm) { uncertain++; continue; }
      detected++;
      setDemos((current) => current.map((item) => item.id === demo.id ? { ...item, bpm: analysis.bpm, duration: analysis.duration, updatedAt: Date.now() } : item));
    }
    setImportNotice(`${detected} ${detected === 1 ? "demo" : "demos"} analyzed${noAudio ? ` · ${noAudio} skipped without audio` : ""}${uncertain ? ` · ${uncertain} had no steady tempo` : ""}.`);
    setDetectProgress("");
    setShowBulkDetect(false);
  }

  async function requestPersistentStorage() {
    await refreshStorageInfo();
    setStorageProgress("SQLite and managed file copies are stored in Demolition’s local data folder.");
  }

  async function verifyAudioCopies() {
    const targets = demos.filter((demo) => demo.audioName);
    if (!targets.length) { setStorageProgress("There are no audio copies to verify yet."); return; }
    let verified = 0;
    let missing = 0;
    let damaged = 0;
    for (let index = 0; index < targets.length; index++) {
      const demo = targets[index];
      setStorageProgress(`Verifying ${index + 1} of ${targets.length}: ${demo.title}`);
      const blob = await getAudio(demo.id).catch(() => undefined);
      if (!blob) { missing++; continue; }
      const checksum = await checksumBlob(blob);
      if (demo.checksum && checksum !== demo.checksum) { damaged++; continue; }
      verified++;
      setDemos((current) => current.map((item) => item.id === demo.id ? { ...item, checksum, fileSize: blob.size, copyVerifiedAt: Date.now() } : item));
    }
    setStorageProgress(`${verified} verified · ${missing} missing · ${damaged} checksum ${damaged === 1 ? "mismatch" : "mismatches"}.`);
    await refreshStorageInfo();
  }

  function startRapidListen() {
    const ids = [...demos].sort((a, b) => {
      const aStats = statsFor(a.id);
      const bStats = statsFor(b.id);
      return aStats.count - bStats.count || (aStats.lastAt ?? 0) - (bStats.lastAt ?? 0) || a.updatedAt - b.updatedAt;
    }).map((demo) => demo.id);
    if (!ids.length) { window.alert("Import some demos before starting listen mode."); return; }
    setRapidIds(ids);
    setRapidIndex(0);
    resetRapidResponse();
    setSelectedId(ids[0]);
    setRapidMode(true);
  }

  function resetRapidResponse() {
    setRapidNote("");
    setRapidVote(undefined);
    setRapidVoteEventUuid(undefined);
    setRapidCurrentTime(0);
    setRapidDuration(0);
    setTimedNoteRange(undefined);
    setTimedNoteDraft("");
    setEditingTimedNoteUuid(undefined);
    annotationDragStartRef.current = undefined;
  }

  function annotationSeconds(clientX: number) {
    const rail = annotationRailRef.current;
    if (!rail || !rapidDuration) return 0;
    const bounds = rail.getBoundingClientRect();
    return Math.max(0, Math.min(rapidDuration, (clientX - bounds.left) / bounds.width * rapidDuration));
  }

  function beginTimedNoteRange(event: React.PointerEvent<HTMLDivElement>) {
    if (!rapidDuration || event.button !== 0) return;
    const seconds = annotationSeconds(event.clientX);
    annotationDragStartRef.current = seconds;
    setTimedNoteRange({ start: seconds, end: seconds });
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveTimedNoteRange(event: React.PointerEvent<HTMLDivElement>) {
    const origin = annotationDragStartRef.current;
    if (origin === undefined) return;
    const seconds = annotationSeconds(event.clientX);
    setTimedNoteRange({ start: Math.min(origin, seconds), end: Math.max(origin, seconds) });
  }

  function finishTimedNoteRange(event: React.PointerEvent<HTMLDivElement>) {
    const origin = annotationDragStartRef.current;
    if (origin === undefined) return;
    const seconds = annotationSeconds(event.clientX);
    let start = Math.min(origin, seconds);
    let end = Math.max(origin, seconds);
    if (end - start < 0.5) {
      end = Math.min(rapidDuration, start + 0.5);
      start = Math.max(0, end - 0.5);
    }
    setTimedNoteRange({ start, end });
    annotationDragStartRef.current = undefined;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function saveTimedNote(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!rapidDemo || !account || !timedNoteRange || !timedNoteDraft.trim()) return;
    if (editingTimedNoteUuid) {
      setTimedNotes((current) => current.map((note) => note.noteUuid === editingTimedNoteUuid && note.authorId === account.id ? {
        ...note,
        startSeconds: timedNoteRange.start,
        endSeconds: timedNoteRange.end,
        note: timedNoteDraft.trim(),
        signature: undefined,
      } : note));
      cancelTimedNoteEdit();
      return;
    }
    const createdAt = Date.now();
    setTimedNotes((current) => [...current, {
      id: createdAt * 1000 + Math.floor(Math.random() * 1000), noteUuid: crypto.randomUUID(),
      demoId: rapidDemo.id, demoUuid: rapidDemo.uuid, authorId: account.id, authorName: account.displayName,
      startSeconds: timedNoteRange.start, endSeconds: timedNoteRange.end, note: timedNoteDraft.trim(), createdAt,
    }]);
    setTimedNoteRange(undefined);
    setTimedNoteDraft("");
  }

  function cancelTimedNoteEdit() {
    setTimedNoteRange(undefined);
    setTimedNoteDraft("");
    setEditingTimedNoteUuid(undefined);
  }

  function editTimedNote(note: TimedNote) {
    if (!account || note.authorId !== account.id) return;
    if (!rapidMode || rapidDemo?.id !== note.demoId) {
      resetRapidResponse();
      setRapidIds([note.demoId]);
      setRapidIndex(0);
      setSelectedId(note.demoId);
      setRapidMode(true);
    }
    setEditingTimedNoteUuid(note.noteUuid);
    setTimedNoteRange({ start: note.startSeconds, end: note.endSeconds });
    setTimedNoteDraft(note.note);
  }

  function deleteTimedNote(note: TimedNote) {
    if (!account || note.authorId !== account.id) return;
    if (!window.confirm(`Delete the timed note at ${formatDuration(note.startSeconds)}?`)) return;
    setTimedNotes((current) => current.filter((item) => item.noteUuid !== note.noteUuid));
    if (editingTimedNoteUuid === note.noteUuid) cancelTimedNoteEdit();
  }

  function seekTimedNote(note: TimedNote) {
    const player = rapidMode && rapidDemo?.id === note.demoId ? rapidAudioRef.current : detailAudioRef.current;
    if (!player) return;
    player.currentTime = note.startSeconds;
    player.play().catch(() => undefined);
  }

  function previousRapid() {
    if (rapidIndex <= 0) return;
    const previousIndex = rapidIndex - 1;
    resetRapidResponse();
    setRapidIndex(previousIndex);
    setSelectedId(rapidIds[previousIndex]);
  }

  function advanceRapid() {
    if (!rapidDemo) return;
    const nextIndex = rapidIndex + 1;
    if (nextIndex >= rapidIds.length) {
      setRapidMode(false);
      setImportNotice("Listening round complete.");
      return;
    }
    resetRapidResponse();
    setRapidIndex(nextIndex);
    setSelectedId(rapidIds[nextIndex]);
  }

  function recordListen(verdict: "up" | "down") {
    if (!rapidDemo || !account) return;
    if (rapidVoteEventUuid) {
      setListens((current) => current.map((listen) => listen.eventUuid === rapidVoteEventUuid ? { ...listen, verdict, note: rapidNote.trim(), signature: undefined } : listen));
      setRapidVote(verdict);
      return;
    }
    const listenedAt = Date.now();
    const id = listenedAt * 1000 + Math.floor(Math.random() * 1000);
    const eventUuid = crypto.randomUUID();
    setListens((current) => [{
      id, eventUuid, demoId: rapidDemo.id, demoUuid: rapidDemo.uuid,
      authorId: account.id, authorName: account.displayName, verdict, note: rapidNote.trim(), listenedAt,
    }, ...current]);
    setRapidVote(verdict);
    setRapidVoteEventUuid(eventUuid);
  }

  function updateRapidNote(value: string) {
    setRapidNote(value);
    if (rapidVoteEventUuid) setListens((current) => current.map((listen) => listen.eventUuid === rapidVoteEventUuid ? { ...listen, note: value.trim(), signature: undefined } : listen));
  }

  useEffect(() => {
    rapidActionsRef.current = {
      previous: previousRapid,
      next: advanceRapid,
      down: () => recordListen("down"),
      up: () => recordListen("up"),
    };
  });

  function changeRapidProject(nextProject: string) {
    if (!rapidDemo) return;
    const previousProject = rapidDemo.project;
    setDemos((current) => current.map((demo) => demo.id === rapidDemo.id ? { ...demo, project: nextProject, updatedAt: Date.now() } : demo));
    if (previousProject !== nextProject) setOrders((current) => ({ ...current, [previousProject]: (current[previousProject] ?? []).filter((id) => id !== rapidDemo.id) }));
  }

  async function removeSelectedAudioCopy() {
    if (!selected.audioName) return;
    if (!window.confirm(`Remove Demolition’s private copy of “${selected.audioName}”? Your original source file will not be touched.`)) return;
    await deleteAudioCopy(selected.id);
    setDemos((current) => current.map((demo) => demo.id === selected.id ? { ...demo, audioName: undefined, checksum: undefined, fileSize: undefined, copyVerifiedAt: undefined, updatedAt: Date.now() } : demo));
    await refreshStorageInfo();
  }

  function addProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name")).trim();
    if (!name || projectNames.includes(name)) return;
    setProjects((current) => [...current, { name, color: String(form.get("color") || "blue") as Project["color"], mood: String(form.get("mood") || "") }]);
    setOrders((current) => ({ ...current, [name]: [] }));
    setShowProject(false);
    selectProject(name);
  }

  function updateProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const nextName = String(form.get("name")).trim();
    const nextColor = String(form.get("color")) as Project["color"];
    const nextMood = String(form.get("mood") || "");
    if (!nextName) return;
    if (nextName !== project && projectNames.includes(nextName)) { window.alert("A project with that name already exists."); return; }
    setProjects((current) => current.map((item) => item.name === project ? { ...item, name: nextName, color: nextColor, mood: nextMood } : item));
    if (nextName !== project) {
      const previousName = project;
      setDemos((current) => current.map((demo) => demo.project === previousName ? { ...demo, project: nextName } : demo));
      setMedia((current) => current.map((item) => item.project === previousName ? { ...item, project: nextName } : item));
      setOrders((current) => {
        const next = { ...current, [nextName]: current[previousName] ?? [] };
        delete next[previousName];
        return next;
      });
      setProject(nextName);
    }
    setShowProjectSettings(false);
  }

  async function deleteProject() {
    const affectedDemos = demos.filter((demo) => demo.project === project).length;
    const affectedMedia = media.filter((item) => item.project === project);
    const message = `Delete “${project}”? ${affectedDemos} ${affectedDemos === 1 ? "demo" : "demos"} will move to Unsorted and ${affectedMedia.length} moodboard ${affectedMedia.length === 1 ? "item" : "items"} will be removed.`;
    if (!window.confirm(message)) return;
    await Promise.all(affectedMedia.filter((item) => item.source === "file").map((item) => deleteProjectMedia(item.id)));
    setProjects((current) => current.filter((item) => item.name !== project));
    setDemos((current) => current.map((demo) => demo.project === project ? { ...demo, project: "Unsorted", updatedAt: Date.now() } : demo));
    setMedia((current) => current.filter((item) => item.project !== project));
    setOrders((current) => { const next = { ...current }; delete next[project]; return next; });
    setShowProjectSettings(false);
    setProject("All demos");
    setView("library");
  }

  async function addMedia(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const file = form.get("file");
    const hasFile = file instanceof File && file.size > 0;
    const url = String(form.get("url") || "").trim();
    if (!hasFile && !url) return;
    if (!hasFile) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Unsupported link");
      } catch { window.alert("Add a complete http:// or https:// link."); return; }
    }
    const id = Date.now();
    let kind = String(form.get("kind") || "link") as ProjectMedia["kind"];
    if (hasFile) {
      if (file.type.startsWith("image/")) kind = "image";
      else if (file.type.startsWith("video/")) kind = "video";
      else if (file.type.startsWith("audio/")) kind = "audio";
      await putProjectMedia(id, file);
    }
    const item: ProjectMedia = {
      id, project, kind, source: hasFile ? "file" : "url",
      title: String(form.get("title") || (hasFile ? file.name.replace(/\.[^.]+$/, "") : url)),
      note: String(form.get("note") || ""), fileName: hasFile ? file.name : undefined,
      url: hasFile ? undefined : url, createdAt: Date.now(),
    };
    setMedia((current) => [item, ...current]);
    setShowMedia(false);
  }

  function updateProjectMood(value: string) {
    setProjects((current) => current.map((item) => item.name === project ? { ...item, mood: value } : item));
  }

  async function removeMedia(item: ProjectMedia) {
    if (!window.confirm(`Remove “${item.title}” from this moodboard?`)) return;
    if (item.source === "file") await deleteProjectMedia(item.id);
    setMedia((current) => current.filter((mediaItem) => mediaItem.id !== item.id));
  }

  function dropOnTracklist(targetId?: number) {
    if (!draggedId || project === "All demos") return;
    const ids = (orders[project] ?? []).filter((id) => id !== draggedId);
    const targetIndex = targetId ? ids.indexOf(targetId) : -1;
    if (targetIndex >= 0) ids.splice(targetIndex, 0, draggedId);
    else ids.push(draggedId);
    setOrders((current) => ({ ...current, [project]: ids }));
    setDraggedId(undefined);
  }

  function dropInCandidatePool() {
    if (!draggedId) return;
    setOrders((current) => ({ ...current, [project]: (current[project] ?? []).filter((id) => id !== draggedId) }));
    setDraggedId(undefined);
  }

  function pickForMe() {
    if (!revisitDemos.length) return;
    const candidate = revisitDemos[Math.floor(Math.random() * revisitDemos.length)];
    setSelectedId(candidate.id);
    setProject("All demos");
    setView("revisit");
  }

  function addCustomTag(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const names = parseTags(String(form.get("name") || ""));
    if (!names.length) return;
    setTags((current) => mergeTags(current, names));
    event.currentTarget.reset();
  }

  function removeCustomTag(name: string) {
    const count = demos.filter((demo) => demo.tags.some((tag) => tag.toLocaleLowerCase() === name.toLocaleLowerCase())).length;
    if (!window.confirm(`Delete “${name}”? It will be removed from ${count} ${count === 1 ? "demo" : "demos"}.`)) return;
    setTags((current) => current.filter((tag) => tag.name.toLocaleLowerCase() !== name.toLocaleLowerCase()));
    setDemos((current) => current.map((demo) => ({ ...demo, tags: demo.tags.filter((tag) => tag.toLocaleLowerCase() !== name.toLocaleLowerCase()) })));
    if (tagFilter.toLocaleLowerCase() === name.toLocaleLowerCase()) setTagFilter("All tags");
  }

  function applyPeerWorkspace(data: Awaited<ReturnType<typeof loadWorkspace>>) {
    setDemos(data.demos);
    setProjects(data.projects);
    setTags(mergeTags(data.tags ?? [], data.demos.flatMap((demo) => demo.tags)));
    setMedia(data.media);
    setListens(data.listens ?? []);
    setTimedNotes(data.timedNotes ?? []);
    setAccount(data.account);
    setFriends(data.friends ?? []);
    setShares(data.shares ?? []);
    setOrders(data.orders);
  }

  async function saveAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const updated = await apiRequest<Account>("/api/account", {
        method: "PUT",
        body: JSON.stringify({ displayName: form.get("displayName"), peerUrl: form.get("peerUrl") }),
      });
      setAccount(updated);
      setMeshProgress("Account saved.");
    } catch (error) {
      setMeshProgress(error instanceof Error ? error.message : "Account could not be saved.");
    }
  }

  async function createInvite() {
    try {
      const result = await apiRequest<{ code: string }>("/api/invites", { method: "POST", body: "{}" });
      setPairingCode(result.code);
      setMeshProgress("Invitation created. It expires in 24 hours and works once.");
    } catch (error) {
      setMeshProgress(error instanceof Error ? error.message : "Invitation could not be created.");
    }
  }

  async function pairFriend(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const code = String(form.get("code") || "").trim();
    if (!code) return;
    setMeshProgress("Pairing…");
    try {
      await apiRequest("/api/friends/pair", { method: "POST", body: JSON.stringify({ code }) });
      applyPeerWorkspace(await loadWorkspace());
      event.currentTarget.reset();
      setMeshProgress("Friend connected.");
    } catch (error) {
      setMeshProgress(error instanceof Error ? error.message : "Pairing failed.");
    }
  }

  async function syncFriend(friend: Friend) {
    setMeshProgress(`Syncing with ${friend.displayName}…`);
    try {
      await saveQueue;
      const result = await apiRequest<{ audioCopied: number; workspace: Awaited<ReturnType<typeof loadWorkspace>> }>(`/api/friends/${encodeURIComponent(friend.id)}/sync`, { method: "POST", body: "{}" });
      applyPeerWorkspace(result.workspace);
      setMeshProgress(`Synced with ${friend.displayName}${result.audioCopied ? ` · ${result.audioCopied} audio ${result.audioCopied === 1 ? "file" : "files"} copied` : ""}.`);
    } catch (error) {
      setMeshProgress(error instanceof Error ? error.message : `Could not sync with ${friend.displayName}.`);
      applyPeerWorkspace(await loadWorkspace());
    }
  }

  async function disconnectFriend(friend: Friend) {
    if (!window.confirm(`Disconnect ${friend.displayName}? Their existing ratings will remain attributed to them.`)) return;
    await apiRequest(`/api/friends/${encodeURIComponent(friend.id)}`, { method: "DELETE" });
    setFriends((current) => current.filter((item) => item.id !== friend.id));
    setShares((current) => current.filter((share) => share.friendId !== friend.id));
  }

  function toggleDemoShare(demo: Demo, friendId: string) {
    if (!account || demo.ownerId !== account.id) return;
    setShares((current) => current.some((share) => share.demoUuid === demo.uuid && share.friendId === friendId)
      ? current.filter((share) => share.demoUuid !== demo.uuid || share.friendId !== friendId)
      : [...current, { demoUuid: demo.uuid, friendId, shareAudio: true }]);
  }

  function exportBackup() {
    const payload = JSON.stringify({ version: 7, exportedAt: new Date().toISOString(), demos, projects, tags, orders, media, listens, timedNotes, shares }, null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `demolition-backup-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function importBackup(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.demos) || !Array.isArray(data.projects)) throw new Error("Invalid backup");
      const restoredDemos = data.demos.map((demo: Demo) => ({ ...demo, uuid: demo.uuid || crypto.randomUUID(), ownerId: demo.ownerId || account?.id || "" }));
      const demosById = new Map(restoredDemos.map((demo: Demo) => [demo.id, demo]));
      const restoredListens = (Array.isArray(data.listens) ? data.listens : []).map((listen: ListenEvent) => ({
        ...listen, eventUuid: listen.eventUuid || crypto.randomUUID(), demoUuid: listen.demoUuid || demosById.get(listen.demoId)?.uuid || "",
        authorId: listen.authorId || account?.id || "", authorName: listen.authorName || account?.displayName || "Owner", signature: listen.authorId ? listen.signature : undefined,
      }));
      const restoredTimedNotes = (Array.isArray(data.timedNotes) ? data.timedNotes : []).map((note: TimedNote) => ({
        ...note, noteUuid: note.noteUuid || crypto.randomUUID(), demoUuid: note.demoUuid || demosById.get(note.demoId)?.uuid || "",
        authorId: note.authorId || account?.id || "", authorName: note.authorName || account?.displayName || "Owner", signature: note.authorId ? note.signature : undefined,
      }));
      const restoredTags = mergeTags(Array.isArray(data.tags) ? data.tags : [], restoredDemos.flatMap((demo: Demo) => demo.tags));
      setDemos(restoredDemos); setProjects(data.projects); setTags(restoredTags); setOrders(data.orders ?? {}); setMedia(data.media ?? []); setListens(restoredListens); setTimedNotes(restoredTimedNotes); setShares(data.shares ?? []);
      setSelectedId(restoredDemos[0]?.id ?? 1); setProject("All demos"); setView("library");
    } catch { window.alert("That file is not a valid Demolition backup."); }
    event.target.value = "";
  }

  const currentTitle = view === "revisit" ? "Revisit queue" : view === "project" ? project : "Demo library";

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">✳</span><span>demolition</span></div>
        <div className="sidebar-label">Workspace</div>
        <nav className="main-nav" aria-label="Main navigation">
          <button onClick={() => selectProject("All demos")} className={`nav-item ${view === "library" ? "active" : ""}`}><span>▦</span> Demo library <b>{demos.length}</b></button>
          <button onClick={() => { setView("revisit"); setProject("All demos"); setFilter("All"); }} className={`nav-item ${view === "revisit" ? "active" : ""}`}><span>◌</span> Revisit queue <b className="inbox-count">{revisitDemos.length}</b></button>
          <button onClick={() => setShowTags(true)} className="nav-item"><span>#</span> Manage tags <b>{tags.length}</b></button>
          <button onClick={exportBackup} className="nav-item"><span>⇩</span> Export backup</button>
          <button onClick={() => importRef.current?.click()} className="nav-item"><span>⇧</span> Restore backup</button>
          <button onClick={() => { setDetectProgress(""); setShowBulkDetect(true); }} className="nav-item"><span>⌁</span> Detect BPM <b>{demos.filter((demo) => !demo.bpm).length}</b></button>
          <button onClick={startRapidListen} className="nav-item"><span>▶</span> Listen mode</button>
          <button onClick={() => { setMeshProgress(""); setShowAccount(true); }} className="nav-item"><span>◎</span> Friends &amp; sync <b>{friends.length}</b></button>
          <button onClick={() => { setStorageProgress(""); refreshStorageInfo().catch(() => undefined); setShowStorage(true); }} className="nav-item"><span>◈</span> Storage health</button>
          <input ref={importRef} className="sr-only" type="file" accept="application/json" onChange={importBackup} />
        </nav>
        <div className="sidebar-label project-label">Projects <button onClick={() => setShowProject(true)} aria-label="Add project">+</button></div>
        <div className="project-list">
          {projects.map((item) => <button key={item.name} onClick={() => selectProject(item.name)} className={`project-item ${view === "project" && project === item.name ? "selected" : ""}`}><span className={`project-dot ${item.color}`} />{item.name}<span className="count">{demos.filter((demo) => demo.project === item.name).length}</span></button>)}
          <button onClick={() => selectProject("Unsorted")} className={`project-item ${view === "project" && project === "Unsorted" ? "selected" : ""}`}><span className="project-dot muted" />Unsorted<span className="count">{demos.filter((demo) => demo.project === "Unsorted").length}</span></button>
        </div>
        <div className="local-badge"><span>●</span><div><strong>Local SQLite library</strong><small>Original files remain untouched</small></div></div>
        <div className="sidebar-bottom"><div className="mini-avatar">{account?.displayName.slice(0, 2).toUpperCase() || "—"}</div><div><strong>{account?.displayName || "Local owner"}</strong><span>{friends.length} connected {friends.length === 1 ? "friend" : "friends"}</span></div></div>
      </aside>

      <section className="content">
        <header className="topbar"><div className="breadcrumb"><span>Workspace</span><i>/</i><strong>{currentTitle}</strong></div><div className="top-actions"><label className="search"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search demos" /></label><button className="avatar" aria-label="Open account" onClick={() => setShowAccount(true)}>{account?.displayName.slice(0, 2).toUpperCase() || "—"}</button></div></header>
        <div className="page-content">
          <div className="heading-row"><div><div className="eyebrow">{new Intl.DateTimeFormat("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date()).toUpperCase()}</div><h1>{view === "revisit" ? "Revisit queue" : view === "project" ? project : "Demo library"}</h1><p className="lede">{view === "revisit" ? `${revisitDemos.length} demos are queued, oldest first.` : view === "project" ? projectTab === "moodboard" ? "Collect visual, video, and audio references for this project." : "Move demos between the candidate pool and ordered tracklist." : <>Your library contains <strong>{demos.length} demos</strong>, with <strong>{revisitDemos.length}</strong> queued for review.</>}</p></div><div className="heading-actions">{view === "revisit" && <button className="secondary-button" onClick={pickForMe}>Pick one for me</button>}{view === "project" && project !== "Unsorted" && <button className="settings-button" onClick={() => setShowProjectSettings(true)} aria-label={`Manage ${project}`}>⚙ Project settings</button>}{view === "project" && project !== "Unsorted" && projectTab === "moodboard" && <button className="secondary-button" onClick={() => setShowMedia(true)}>＋ Add reference</button>}<button className="secondary-button" onClick={() => setShowAdd(true)}>＋ One demo</button><button className="primary-button" onClick={() => { setBulkProgress(""); setShowBulk(true); }}><span>＋</span> Bulk import</button></div></div>
          {importNotice && <div className="import-notice" role="status"><span>✓</span><p>{importNotice}</p><button onClick={() => setImportNotice("")} aria-label="Dismiss import summary">×</button></div>}

          <div className="stats-grid"><div className="stat-card hero-stat"><span className="stat-label">TOTAL DEMOS</span><strong>{demos.length}</strong><span className="stat-foot lime-text">Saved on this device</span><div className="mini-bars">{Array.from({ length: 12 }, (_, index) => <i key={index} />)}</div></div><div className="stat-card"><span className="stat-label">IN PROJECTS</span><strong>{inProjects}</strong><span className="stat-foot">{demos.length ? Math.round(inProjects / demos.length * 100) : 0}% of your library</span><div className="progress"><span style={{ width: `${demos.length ? inProjects / demos.length * 100 : 0}%` }} /></div></div><div className="stat-card"><span className="stat-label">READY TO REVISIT</span><strong>{revisitDemos.length}</strong><span className="stat-foot coral-text">Sorted by oldest update</span><div className="ring" style={{ background: `conic-gradient(var(--coral) 0 ${demos.length ? revisitDemos.length / demos.length * 100 : 0}%, #383a34 0)` }}><span>{demos.length ? Math.round(revisitDemos.length / demos.length * 100) : 0}%</span></div></div></div>

          {view === "project" && project !== "Unsorted" && <div className="project-tabs" role="tablist" aria-label={`${project} project sections`}><button role="tab" aria-selected={projectTab === "tracklist"} className={projectTab === "tracklist" ? "active" : ""} onClick={() => setProjectTab("tracklist")}><span>☷</span> Tracklist <b>{projectOrder.length}</b></button><button role="tab" aria-selected={projectTab === "moodboard"} className={projectTab === "moodboard" ? "active" : ""} onClick={() => setProjectTab("moodboard")}><span>▦</span> Moodboard <b>{projectMedia.length}</b></button></div>}

          {view === "project" && projectTab === "moodboard" ? <section className="moodboard-view">
            <div className="mood-header"><div><div className="eyebrow">AESTHETIC NOTES</div><textarea value={currentProject?.mood ?? ""} onChange={(event) => updateProjectMood(event.target.value)} placeholder="Describe the intended visual and sonic direction" rows={2} /></div><span className="saved-note">{ready ? "✓ Saved locally" : "Loading…"}</span></div>
            {projectMedia.length ? <div className="mood-grid">{projectMedia.map((item) => {
              const source = item.source === "file" ? mediaUrls[item.id] : item.url;
              return <article className={`mood-card mood-${item.kind}`} key={item.id}>
                <button className="media-remove" onClick={() => removeMedia(item)} aria-label={`Remove ${item.title}`}>×</button>
                {item.kind === "image" && source && <img src={source} alt={item.title} />}
                {item.kind === "video" && source && <video src={source} controls preload="metadata"><track kind="captions" src="data:text/vtt,WEBVTT" srcLang="en" label="Media reference" /></video>}
                {item.kind === "audio" && <div className="mood-audio"><span>◉</span><small>SONIC REFERENCE</small>{source && <audio src={source} controls preload="metadata"><track kind="captions" src="data:text/vtt,WEBVTT" srcLang="en" label="Music reference" /></audio>}</div>}
                {item.kind === "link" && <a className="mood-link" href={item.url} target="_blank" rel="noreferrer"><span>↗</span><small>WEB REFERENCE</small><strong>{item.url?.replace(/^https?:\/\//, "").split("/")[0]}</strong></a>}
                <div className="mood-caption"><span className="media-kind">{item.kind}</span><h3>{item.title}</h3>{item.note && <p>{item.note}</p>}</div>
              </article>;
            })}</div> : <button className="mood-empty" onClick={() => setShowMedia(true)}><span className="mood-empty-mark">✳</span><strong>No references added</strong><small>Add images, videos, audio, or links for this project.</small><b>＋ Add first reference</b></button>}
          </section> : <>
          <div className="section-heading"><div><h2>{currentTitle}</h2><span className="muted">{view === "project" ? "Drag rows to reorder the tracklist." : view === "revisit" ? "Demos marked Unheard or Revisit, sorted oldest first." : "Filter, search, and sort your demos."}</span></div><span className="saved-note">{ready ? "✓ Changes saved locally" : "Loading your library…"}</span></div>
          <div className={`workspace-grid ${view === "project" && project !== "Unsorted" ? "project-workspace" : ""}`}>
            <div className="demo-panel" onDragOver={(event) => { if (view === "project") event.preventDefault(); }} onDrop={() => { if (view === "project") dropOnTracklist(); }}><div className="filter-row"><div className="filters">{["All", "Unheard", "Revisit", "Shaping", "Finished"].map((item) => <button key={item} onClick={() => setFilter(item)} className={filter === item ? "filter-active" : ""}>{item}</button>)}</div><div className="filter-tools"><select className="tag-select" value={tagFilter} onChange={(event) => setTagFilter(event.target.value)} aria-label="Filter by tag"><option>All tags</option>{tags.map((tag) => <option key={tag.name}>{tag.name}</option>)}</select>{view === "project" ? <span className="sort-button">↕ Drag to reorder</span> : <select className="sort-select" value={sortBy} onChange={(event) => setSortBy(event.target.value as typeof sortBy)} aria-label="Sort demos"><option value="score">Score · highest</option><option value="updated">Recently updated</option><option value="created-new">Creation date · newest</option><option value="created-old">Creation date · oldest</option><option value="title">Title · A–Z</option></select>}</div></div><div className="demo-table"><div className="table-head"><span>{view === "project" ? "TRACK / DEMO" : "DEMO"}</span><span>DETAILS</span><span>STATUS</span><span>UPDATED</span><span /></div>{visibleDemos.map((demo, index) => <button key={demo.id} draggable={view === "project"} onDragStart={() => setDraggedId(demo.id)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.stopPropagation(); dropOnTracklist(demo.id); }} onClick={() => setSelectedId(demo.id)} className={`demo-row ${selectedId === demo.id ? "row-selected" : ""}`}><span className="demo-name">{view === "project" && <b className="track-number">{String(index + 1).padStart(2, "0")}</b>}<span className={`cover cover-${demo.id % 4}`}><i /></span><span><strong>{demo.title}</strong><small>{demo.creationDate && <b className="date-tag">{formatCreationDate(demo.creationDate)}</b>}{demo.tags.join("  ·  ")}{demo.audioName ? "  ·  audio linked" : ""}</small></span></span><span className="details">{demo.bpm ? `${demo.bpm} BPM` : "BPM —"} <i>·</i> {demo.key} <i>·</i> {demo.duration} <i>·</i> Score {statsFor(demo.id).score > 0 ? `+${statsFor(demo.id).score}` : statsFor(demo.id).score}</span><span><b className={`status ${demo.status}`}>{statusLabels[demo.status]}</b></span><span className="updated">{relativeDate(demo.updatedAt)}</span><span className="row-arrow">→</span></button>)}</div>{visibleDemos.length === 0 && (view === "project" ? <div className="empty-state tracklist-empty">Drag candidates here to begin the tracklist.</div> : demos.length === 0 ? <div className="empty-state library-empty"><span>✳</span><strong>Your library is empty</strong><p>Choose a folder of demo bounces to start building your archive.</p><button onClick={() => { setBulkProgress(""); setShowBulk(true); }}>＋ Import your demos</button></div> : <div className="empty-state">No demos match this view.</div>)}</div>

            {view === "project" && project !== "Unsorted" && <aside className="candidate-panel" onDragOver={(event) => event.preventDefault()} onDrop={dropInCandidatePool}><div className="candidate-head"><div><span className="eyebrow">CANDIDATE POOL</span><h3>{projectCandidates.length} candidate {projectCandidates.length === 1 ? "track" : "tracks"}</h3></div><span>Drag into tracklist →</span></div><div className="candidate-list">{projectCandidates.map((demo) => <div key={demo.id} className="candidate-row" draggable onDragStart={() => setDraggedId(demo.id)}><button onClick={() => setSelectedId(demo.id)}><span className={`cover cover-${demo.id % 4}`}><i /></span><span><strong>{demo.title}</strong><small>{demo.bpm ? `${demo.bpm} BPM` : "BPM unknown"} · {statusLabels[demo.status]}</small></span></button><button className="promote-button" onClick={() => setOrders((current) => ({ ...current, [project]: [...(current[project] ?? []).filter((id) => id !== demo.id), demo.id] }))} aria-label={`Add ${demo.title} to tracklist`}>＋</button></div>)}{projectCandidates.length === 0 && <div className="candidate-empty"><span>✓</span><strong>No candidates</strong><small>Import demos here or drag a track out of the tracklist.</small></div>}</div><div className="candidate-drop">← Drop here to return a track to the pool</div></aside>}

            {selected && (view !== "project" || project === "Unsorted") && <aside className="detail-panel"><div className="detail-top"><span className="eyebrow">SELECTED DEMO</span><button className="more-button" onClick={openEdit}>Edit</button></div><div className={`focus-cover cover-${selected.id % 4}`}><span>✳</span></div><h3>{selected.title}</h3><div className="focus-meta">{selected.bpm ? `${selected.bpm} BPM` : "BPM —"} <i>·</i> {selected.key} <i>·</i> {selected.duration}</div><button className="detect-bpm" disabled={detectingId === selected.id} onClick={detectSelectedBpm}>{detectingId === selected.id ? "◌ Analyzing tempo…" : "⌁ Detect BPM again"}</button><div className="listen-summary" aria-label={"Listen score " + selectedStats.score}><span><b>{selectedStats.up}</b> ↑</span><span><b>{selectedStats.down}</b> ↓</span><strong>{selectedStats.score > 0 ? "+" + selectedStats.score : selectedStats.score}</strong><small>{selectedStats.count} {selectedStats.count === 1 ? "listen" : "listens"} · You {selectedOwnerScore > 0 ? "+" + selectedOwnerScore : selectedOwnerScore} · Friends {selectedFriendScore > 0 ? "+" + selectedFriendScore : selectedFriendScore}</small></div>{selectedListenHistory}{selectedTimedNoteHistory}{audioUrl ? <><audio ref={detailAudioRef} className="audio-player" src={audioUrl} controls preload="metadata" onTimeUpdate={(event) => setDetailCurrentTime(event.currentTarget.currentTime)} onSeeked={(event) => setDetailCurrentTime(event.currentTarget.currentTime)}><track kind="captions" src="data:text/vtt,WEBVTT" srcLang="en" label="Instrumental audio" /></audio><button className="remove-copy" onClick={removeSelectedAudioCopy}>Remove local copy</button></> : <button className="audio-empty" onClick={() => attachRef.current?.click()}><span>＋</span> Attach an audio bounce</button>}<input ref={attachRef} className="sr-only" type="file" accept="audio/*,.wav,.aif,.aiff,.mp3,.m4a,.flac" onChange={attachAudio} />{selectedSharing}<div className="detail-section"><div className="detail-section-head"><span>NEXT ACTION</span><button onClick={openEdit}>edit</button></div><p className="next-action">→ {selected.nextAction || "No next action set"}</p></div><div className="detail-section"><div className="detail-section-head"><span>NOTES</span><button onClick={openEdit}>edit</button></div><p>{selected.note || "No notes yet."}</p></div><div className="detail-section"><div className="detail-section-head"><span>PROJECT</span><button onClick={openEdit}>change</button></div><div className="assigned-project"><span className="project-dot coral" />{selected.project}<span>↗</span></div></div><button className="open-demo" onClick={openEdit}>Edit demo <span>↗</span></button></aside>}
          </div></>}
          <div className="bottom-note"><span className="spark">✳</span><span><strong>{revisitDemos.length} demos in the review queue.</strong> Sorted by oldest update.</span><button onClick={() => { setView("revisit"); setProject("All demos"); }}>Open revisit queue →</button></div>
        </div>
      </section>

      {rapidMode && rapidDemo && <div className="rapid-backdrop"><section className="rapid-session" aria-label="Listen mode"><header><div><span className="eyebrow">LISTEN MODE</span><strong>{rapidIndex + 1} / {rapidIds.length}</strong></div><button onClick={() => setRapidMode(false)} aria-label="End listen mode">×</button></header><div className="rapid-body"><div className={`rapid-art cover-${rapidDemo.id % 4}`}><span>✳</span></div><div className="rapid-main"><div className="rapid-title"><div><h2>{rapidDemo.title}</h2><p>{rapidDemo.bpm ? `${rapidDemo.bpm} BPM` : "BPM unknown"} · {rapidDemo.key} · {rapidDemo.duration}</p></div><select aria-label="Assign project" value={rapidDemo.project} onChange={(event) => changeRapidProject(event.target.value)}>{projectNames.map((name) => <option key={name}>{name}</option>)}</select></div>{audioUrl ? <audio ref={rapidAudioRef} className="rapid-player" src={audioUrl} controls onEnded={advanceRapid} onLoadedMetadata={(event) => setRapidDuration(event.currentTarget.duration || 0)} onDurationChange={(event) => setRapidDuration(event.currentTarget.duration || 0)} onTimeUpdate={(event) => setRapidCurrentTime(event.currentTarget.currentTime)} preload="metadata"><track kind="captions" src="data:text/vtt,WEBVTT" srcLang="en" label="Demo audio" /></audio> : <div className="rapid-no-audio">No local audio copy attached</div>}{rapidAnnotationTransport}<div className="rapid-vote-summary"><span>{rapidStats.up} up</span><span>{rapidStats.down} down</span><strong>Score {rapidStats.score > 0 ? `+${rapidStats.score}` : rapidStats.score}</strong></div><label className="rapid-note">Note for this listen<textarea value={rapidNote} onChange={(event) => updateRapidNote(event.target.value)} rows={3} placeholder="Optional note saved with your vote" /></label></div></div><footer><div className="rapid-controls"><button className="rapid-previous" disabled={!rapidIndex} onClick={previousRapid}><span>←</span> Previous <kbd>H</kbd></button><button className="thumb-down" aria-pressed={rapidDownSelected} onClick={() => recordListen("down")}><span>↓</span> Thumbs down <kbd>J</kbd></button><button className="thumb-up" aria-pressed={rapidUpSelected} onClick={() => recordListen("up")}><span>↑</span> Thumbs up <kbd>K</kbd></button><button className="rapid-next-track" onClick={advanceRapid}>Next <span>→</span> <kbd>L</kbd></button></div></footer></section></div>}

      {showAccount && account && <div className="modal-backdrop"><section className="modal mesh-modal" aria-label="Friends and sync"><button type="button" className="modal-close" onClick={() => setShowAccount(false)}>×</button><div className="eyebrow">LOCAL IDENTITY</div><h2>Friends &amp; sync</h2><form className="account-form" onSubmit={saveAccount}><div className="modal-fields"><label>Display name<input name="displayName" defaultValue={account.displayName} required /></label><label>Mesh VPN URL<input name="peerUrl" type="url" defaultValue={account.peerUrl} placeholder="http://100.64.0.10:3001" required /></label></div><span className="field-hint">Use this machine&apos;s stable VPN address. Start the server with DEMOLITION_API_HOST set to 0.0.0.0 so friends can reach it.</span><button className="secondary-button" type="submit">Save identity</button></form><div className="mesh-grid"><section><div className="detail-section-head"><span>INVITE A FRIEND</span></div><p>Create a single-use code and send it through a channel you trust.</p><button className="secondary-button" onClick={createInvite}>Create invitation</button>{pairingCode && <div className="invite-code"><textarea readOnly value={pairingCode} rows={4} aria-label="Pairing invitation code" /><button onClick={() => navigator.clipboard.writeText(pairingCode).then(() => setMeshProgress("Invitation copied."))}>Copy</button></div>}</section><section><div className="detail-section-head"><span>JOIN A FRIEND</span></div><form onSubmit={pairFriend}><textarea name="code" rows={4} placeholder="Paste their invitation code" aria-label="Friend invitation code" required /><button className="secondary-button" type="submit">Pair instance</button></form></section></div><div className="friend-list"><div className="detail-section-head"><span>CONNECTED FRIENDS</span><small>{friends.length}</small></div>{friends.map((friend) => <article key={friend.id}><span className={`peer-status ${friend.status}`} /><div><strong>{friend.displayName}</strong><small>{friend.peerUrl}</small><small>{friend.lastSyncedAt ? `Last synced ${relativeDate(friend.lastSyncedAt)}` : "Not synced yet"}</small></div><button onClick={() => syncFriend(friend)}>Sync now</button><button className="disconnect-peer" onClick={() => disconnectFriend(friend)} aria-label={`Disconnect ${friend.displayName}`}>×</button></article>)}{friends.length === 0 && <div className="friend-empty">No friends connected.</div>}</div>{meshProgress && <div className="mesh-progress" role="status">{meshProgress}</div>}<div className="mesh-security">Peer traffic stays on the VPN. Demolition also requires a separate pairing token and verifies signed rating events.</div></section></div>}

      {showStorage && <div className="modal-backdrop"><section className="modal storage-modal" aria-label="Storage health"><button type="button" className="modal-close" onClick={() => setShowStorage(false)}>×</button><div className="eyebrow">STORAGE HEALTH</div><h2>Storage status</h2><p>Metadata is stored in SQLite. Audio and moodboard files are copied into Demolition’s local data folder.</p><div className="storage-meter"><div><strong>{formatBytes(storageInfo.usage)}</strong><span>used · {formatBytes(Math.max(0, storageInfo.quota - storageInfo.usage))} free</span></div><b>{Math.round(storagePercent)}%</b><div className="storage-bar"><span style={{ width: `${storagePercent}%` }} /></div></div><div className="health-grid"><div className="health-good"><span>✓</span><strong>Local persistent storage</strong><small>The database and managed copies remain on this machine.</small><button onClick={requestPersistentStorage}>Refresh status</button></div><div className="health-good"><span>♢</span><strong>{demos.filter((demo) => demo.checksum).length} checksummed copies</strong><small>SHA-256 fingerprints detect duplicates and unexpected byte changes.</small><button onClick={verifyAudioCopies}>Verify all copies</button></div></div>{storageProgress && <div className="storage-result" role="status">{storageProgress.startsWith("Verifying") ? <i /> : <span>✓</span>}<p>{storageProgress}</p></div>}<div className="backup-clarity"><strong>Metadata backup ≠ audio backup</strong><p>Export Backup preserves your catalogue, projects, notes, and checksums. Your original music files remain the authoritative audio backup.</p></div><button className="primary-button modal-submit" onClick={() => setShowStorage(false)}>Done</button></section></div>}

      {showBulkDetect && <div className="modal-backdrop"><form className="modal bpm-bulk-modal" onSubmit={bulkDetectBpm}><button type="button" className="modal-close" disabled={detectProgress.startsWith("Analyzing")} onClick={() => setShowBulkDetect(false)}>×</button><div className="eyebrow">BULK BPM DETECTION</div><h2>Detect BPM</h2><p>Demolition reads each attached audio file locally and estimates its tempo. Manual BPM values are preserved by default.</p><fieldset className="choice-group"><legend>Which demos?</legend><label aria-label="Analyze demos with missing BPM only"><input type="radio" name="mode" value="missing" defaultChecked /><span><strong>Missing BPM only</strong><small>{demos.filter((demo) => !demo.bpm).length} demos currently need analysis</small></span></label><label aria-label="Re-analyze all demo BPM values"><input type="radio" name="mode" value="all" /><span><strong>Re-analyze all</strong><small>Overwrites existing BPM values in the chosen scope</small></span></label></fieldset><fieldset className="choice-group"><legend>Scope</legend><label aria-label="Analyze the entire library"><input type="radio" name="scope" value="library" defaultChecked /><span><strong>Entire library</strong><small>{demos.length} demos</small></span></label>{view === "project" && project !== "Unsorted" && <label aria-label={`Analyze ${project} only`}><input type="radio" name="scope" value="project" /><span><strong>{project}</strong><small>{demos.filter((demo) => demo.project === project).length} demos in this project</small></span></label>}</fieldset>{detectProgress && <div className={`bulk-progress ${detectProgress.startsWith("No ") ? "bulk-error" : ""}`}><span /><p>{detectProgress}</p></div>}<button className="primary-button modal-submit" disabled={detectProgress.startsWith("Analyzing")} type="submit">{detectProgress.startsWith("Analyzing") ? "Analyzing catalogue…" : "Start BPM detection"} <span>→</span></button><small className="bulk-privacy">Tracks without attached audio are skipped. BPM remains manually editable.</small></form></div>}

      {showBulk && <div className="modal-backdrop"><form className="modal bulk-modal" onSubmit={bulkImport}><button type="button" className="modal-close" disabled={/^(Checking|Analyzing)/.test(bulkProgress)} onClick={() => setShowBulk(false)}>×</button><div className="eyebrow">BULK IMPORT</div><h2>Import audio files</h2><p>Select a folder or choose several audio files. Every imported demo can receive the same batch tags.</p><div className="source-safety"><span>✓</span><div><strong>Your source files are read-only</strong><small>Demolition creates app-managed local copies. It cannot rename, overwrite, or delete anything in the selected folder.</small></div></div><div className="bulk-choices"><label className="file-drop bulk-choice"><span className="bulk-icon">▤</span><strong>Choose a folder</strong><small>Audio from all subfolders · other files ignored</small><input name="folder" type="file" accept="audio/*,.wav,.aif,.aiff,.mp3,.m4a,.flac,.ogg,.opus,.aac" multiple webkitdirectory="" /></label><label className="file-drop bulk-choice"><span className="bulk-icon">♪</span><strong>Choose audio files</strong><small>Select multiple files</small><input name="files" type="file" accept="audio/*,.wav,.aif,.aiff,.mp3,.m4a,.flac,.ogg,.opus,.aac" multiple /></label></div><label>Destination<select name="project" defaultValue={project !== "All demos" && project !== "Unsorted" ? project : projects[0]?.name ?? "Unsorted"}>{projectNames.map((name) => <option key={name}>{name}</option>)}</select></label><label>Batch tags<input name="tags" list="known-tags" placeholder="e.g. April exports, laptop sessions" /><span className="field-hint">Comma separated · applied to every file in this import</span></label>{bulkProgress && <div className={`bulk-progress ${bulkProgress.startsWith("No ") || bulkProgress.startsWith("Not ") || bulkProgress.startsWith("Nothing ") ? "bulk-error" : ""}`}><span /><p>{bulkProgress}</p></div>}<button className="primary-button modal-submit" disabled={/^(Checking|Analyzing)/.test(bulkProgress)} type="submit">{/^(Checking|Analyzing)/.test(bulkProgress) ? "Checking and analyzing…" : "Import safe copies"} <span>→</span></button><small className="bulk-privacy">Only Demolition&apos;s managed copies can be removed from this app.</small></form></div>}

      {showAdd && <div className="modal-backdrop"><form className="modal" onSubmit={addDemo}><button type="button" className="modal-close" onClick={() => setShowAdd(false)}>×</button><div className="eyebrow">IMPORT DEMO</div><h2>Import one demo</h2><p>Choose an audio file. Demolition creates a managed local copy, detects its BPM, and leaves the original untouched.</p><label className="file-drop">Audio file<input name="audio" type="file" accept="audio/*,.wav,.aif,.aiff,.mp3,.m4a,.flac" /><span>Read-only source · managed local copy</span></label><label>Demo title<input name="title" placeholder="Uses the filename if left blank" /></label><div className="modal-fields"><label>BPM<input name="bpm" type="number" placeholder="Auto detect" /></label><label>Key<input name="key" defaultValue="C maj" /></label></div><label>Project<select name="project" defaultValue={project !== "All demos" ? project : "Unsorted"}>{projectNames.map((name) => <option key={name}>{name}</option>)}</select></label><label>Tags<input name="tags" list="known-tags" placeholder="e.g. April exports, laptop sessions" /><span className="field-hint">Comma separated</span></label><button className="primary-button modal-submit" type="submit">Import safe copy <span>→</span></button></form></div>}

      {showEdit && selected && <div className="modal-backdrop"><form className="modal edit-modal" onSubmit={editDemo}><button type="button" className="modal-close" onClick={() => setShowEdit(false)}>×</button><div className="eyebrow">EDIT DEMO</div><h2>{selected.title}</h2><div className="modal-fields"><label>Title<input name="title" defaultValue={selected.title} required /></label><label>Status<select name="status" defaultValue={selected.status}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>BPM<input name="bpm" type="number" defaultValue={selected.bpm} /></label><label>Key<input name="key" defaultValue={selected.key} /></label><label>Project<select name="project" defaultValue={selected.project}>{projectNames.map((name) => <option key={name}>{name}</option>)}</select></label></div><label>Creation date<input name="creationDate" type="date" defaultValue={selected.creationDate} /><span className="field-hint">Extracted from the title when possible; editable anytime.</span></label><label>Tags<input value={editTagsDraft} onChange={(event) => setEditTagsDraft(event.target.value)} placeholder="Type tags separated by commas" /></label>{tags.length > 0 && <div className="tag-picker" aria-label="Available tags">{tags.map((tag) => <button key={tag.name} type="button" className={parseTags(editTagsDraft).some((item) => item.toLocaleLowerCase() === tag.name.toLocaleLowerCase()) ? "selected" : ""} onClick={() => toggleEditTag(tag.name)}>#{tag.name}</button>)}</div>}<label>Next action<input name="nextAction" defaultValue={selected.nextAction} placeholder="One concrete thing to try" /></label><label>Listening notes<textarea name="note" defaultValue={selected.note} rows={4} /></label><button className="primary-button modal-submit" type="submit">Save changes <span>→</span></button></form></div>}

      {showTags && <div className="modal-backdrop"><section className="modal tags-modal" aria-label="Manage tags"><button type="button" className="modal-close" onClick={() => setShowTags(false)}>×</button><div className="eyebrow">TAGS</div><h2>Manage tags</h2><p>Create reusable tags for demo batches, sessions, locations, or any other grouping.</p><form className="tag-create" onSubmit={addCustomTag}><input name="name" placeholder="Tag name" aria-label="New tag name" required /><button className="primary-button" type="submit">Add tag</button></form><div className="tag-manager-list">{tags.map((tag) => { const count = demos.filter((demo) => demo.tags.some((item) => item.toLocaleLowerCase() === tag.name.toLocaleLowerCase())).length; return <div key={tag.name}><button className="tag-filter-link" onClick={() => { setTagFilter(tag.name); setShowTags(false); setProject("All demos"); setView("library"); }}>#{tag.name}<span>{count} {count === 1 ? "demo" : "demos"}</span></button><button className="tag-delete" onClick={() => removeCustomTag(tag.name)} aria-label={`Delete ${tag.name}`}>×</button></div>; })}{tags.length === 0 && <div className="tag-manager-empty">No tags created.</div>}</div></section></div>}

      <datalist id="known-tags">{tags.map((tag) => <option key={tag.name} value={tag.name} />)}</datalist>

      {showMedia && <div className="modal-backdrop"><form className="modal media-modal" onSubmit={addMedia}><button type="button" className="modal-close" onClick={() => setShowMedia(false)}>×</button><div className="eyebrow">ADD TO {project.toUpperCase()}</div><h2>Add a reference</h2><p>Add a local image, video, or audio file, or save a web link. Files are copied into Demolition’s local data folder.</p><label className="file-drop">Local media<input name="file" type="file" accept="image/*,video/*,audio/*,.wav,.aif,.aiff,.mp3,.m4a,.flac" /><span>Image, video, or audio reference</span></label><div className="modal-divider"><span>or add a link</span></div><div className="modal-fields"><label>Web URL<input name="url" type="url" placeholder="https://…" /></label><label>Link type<select name="kind" defaultValue="link"><option value="link">Website / song link</option><option value="image">Direct image URL</option><option value="video">Direct video URL</option><option value="audio">Direct audio URL</option></select></label></div><label>Title<input name="title" placeholder="Uses the filename if left blank" /></label><label>Notes<textarea name="note" rows={3} placeholder="Add context for this reference" /></label><button className="primary-button modal-submit" type="submit">Add to moodboard <span>→</span></button></form></div>}

      {showProjectSettings && currentProject && <div className="modal-backdrop"><form className="modal project-settings-modal" onSubmit={updateProject}><button type="button" className="modal-close" onClick={() => setShowProjectSettings(false)}>×</button><div className="eyebrow">PROJECT SETTINGS</div><h2>Edit project</h2><p>Changes apply to this project’s demos, candidate pool, tracklist, and moodboard.</p><div className="modal-fields"><label>Project name<input name="name" defaultValue={currentProject.name} required /></label><label>Colour<select name="color" defaultValue={currentProject.color}><option value="coral">Signal coral</option><option value="yellow">Warm yellow</option><option value="blue">Night blue</option><option value="violet">Soft violet</option></select></label></div><label>Aesthetic notes<textarea name="mood" defaultValue={currentProject.mood} rows={3} placeholder="Describe the intended visual and sonic direction" /></label><button className="primary-button modal-submit" type="submit">Save project <span>→</span></button><div className="danger-zone"><div><strong>Delete this project</strong><small>Demos move to Unsorted. Moodboard media is removed.</small></div><button type="button" onClick={deleteProject}>Delete project</button></div></form></div>}

      {showProject && <div className="modal-backdrop"><form className="modal project-modal" onSubmit={addProject}><button type="button" className="modal-close" onClick={() => setShowProject(false)}>×</button><div className="eyebrow">NEW PROJECT</div><h2>Create project</h2><p>Group demos, arrange a tracklist, and collect references.</p><div className="modal-fields"><label>Project name<input name="name" placeholder="e.g. Weather Systems" required /></label><label>Colour<select name="color" defaultValue="blue"><option value="coral">Signal coral</option><option value="yellow">Warm yellow</option><option value="blue">Night blue</option><option value="violet">Soft violet</option></select></label></div><label>Aesthetic notes<textarea name="mood" rows={3} placeholder="Describe the intended visual and sonic direction" /></label><button className="primary-button modal-submit" type="submit">Create project <span>→</span></button></form></div>}
    </main>
  );
}
