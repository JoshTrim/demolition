"use client";
/* eslint-disable @next/next/no-img-element -- local blob URLs need native image rendering */

import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";

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
  favorite: boolean;
  project: string;
  updatedAt: number;
  audioName?: string;
  checksum?: string;
  fileSize?: number;
  copyVerifiedAt?: number;
  creationDate?: string;
  trimStartSeconds?: number;
  trimEndSeconds?: number;
};
type Project = { name: string; color: "coral" | "yellow" | "blue" | "violet"; mood?: string };
type TagDefinition = { name: string; createdAt: number };
type ListenEvent = {
  id: number; eventUuid: string; demoId: number; demoUuid: string; authorId: string;
  authorName: string; authorPublicKey?: string; verdict: "up" | "down"; note: string;
  listenedAt: number; receivedAt?: number; signature?: string;
};
type ListenStats = { up: number; down: number; score: number; count: number; lastAt?: number };
type TimedNote = {
  id: number; noteUuid: string; demoId: number; demoUuid: string; authorId: string;
  authorName: string; authorPublicKey?: string; startSeconds: number; endSeconds: number;
  note: string; createdAt: number; receivedAt?: number; signature?: string;
};
type Account = { id: string; displayName: string; instanceId: string; publicKey: string; peerUrl: string; createdAt: number; feedbackSeenAt?: number };
type Friend = { id: string; displayName: string; instanceId: string; peerUrl: string; publicKey: string; status: string; createdAt: number; lastSyncedAt?: number };
type DemoShare = { demoUuid: string; friendId: string; shareAudio: boolean };
type ProjectShare = { project: string; friendId: string; shareAudio: boolean };
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
type View = "library" | "revisit" | "project" | "stats" | "feedback";
type FeedbackFilter = "all" | "ratings" | "notes";
type FeedbackItem = {
  id: string; kind: "rating" | "note"; demoId: number; demoTitle: string; authorName: string;
  text: string; createdAt: number; receivedAt: number; verdict?: "up" | "down"; startSeconds?: number; endSeconds?: number;
};
type RemotePlaybackState = {
  active: boolean; title: string; bpm: number; musicalKey: string; duration: number; currentTime: number;
  playing: boolean; index: number; total: number; up: number; down: number; score: number;
  vote?: "up" | "down"; hasPrevious: boolean; hasNext: boolean;
};
type RemoteCommand = { type: "play-pause" | "previous" | "next" | "skip" | "up" | "down" | "seek"; seconds?: number };
type RemoteSession = { token: string; state: Partial<RemotePlaybackState>; commandSequence: number; command?: RemoteCommand; commands?: Array<{ sequence: number; command: RemoteCommand }>; createdAt: number; updatedAt: number; expiresAt: number };
type StatsFilter = { type: "duration" | "duration-min" | "duration-max" | "bpm" | "bpm-exact" | "bpm-min" | "bpm-max" | "key" | "project" | "status" | "date"; value: string; label: string };
type StatsTrendMetric = "count" | "runtime" | "bpm";
type StatsComparisonMode = "projects" | "dates";
type StorageInfo = { usage: number; quota: number; persisted: boolean };
type PreparedAudio = { file: File; checksum: string; title?: string; bpm?: number; musicalKey?: string };
type RapidAudioEntry = { blob: Blob; url: string };
type FilenameConflict = {
  id: string;
  existing: { kind: "demo"; demoId: number } | { kind: "incoming"; audio: PreparedAudio };
  incoming: PreparedAudio;
};
type PendingBulkImport = {
  destination: string;
  batchTags: string[];
  newFiles: PreparedAudio[];
  replacements: Array<PreparedAudio & { demoId: number }>;
  conflicts: FilenameConflict[];
  exactDuplicates: number;
  filenameSkipped: number;
  skippedFiles: number;
};

const STORAGE_KEY = "demolition-workspace-clean-v1";
const DB_NAME = "demolition-audio";
const MIGRATION_KEY = "demolition-sqlite-migration-v1";
const initialProjects: Project[] = [];
const day = 86_400_000;
const initialDemos: Demo[] = [];

const statusLabels: Record<Status, string> = { unheard: "Unheard", revisit: "Revisit", shaping: "Shaping", finished: "Finished" };

function apiUrl(path: string) {
  const hostname = window.location.hostname;
  const localHost = hostname === "localhost" || hostname === "127.0.0.1";
  const lanAddress = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname);
  const localHostname = hostname.endsWith(".local");
  const uiPort = document.body?.dataset.demolitionUiPort || "3000";
  const localDevelopment = window.location.port === uiPort && (localHost || lanAddress || localHostname);
  const apiHost = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
  const apiPort = document.body?.dataset.demolitionApiPort || "3001";
  return localDevelopment ? `http://${apiHost}:${apiPort}${path}` : path;
}

async function loadWorkspace() {
  const response = await fetch(apiUrl("/api/state"));
  if (!response.ok) throw new Error("The local database is unavailable");
  return response.json() as Promise<{ account: Account; friends: Friend[]; shares: DemoShare[]; projectShares: ProjectShare[]; demos: Demo[]; projects: Project[]; tags: TagDefinition[]; orders: Record<string, number[]>; media: ProjectMedia[]; listens: ListenEvent[]; timedNotes: TimedNote[]; empty: boolean }>;
}

let saveQueue: Promise<void> = Promise.resolve();

function saveWorkspace(payload: { demos: Demo[]; projects: Project[]; tags: TagDefinition[]; orders: Record<string, number[]>; media: ProjectMedia[]; listens: ListenEvent[]; timedNotes: TimedNote[]; shares: DemoShare[]; projectShares: ProjectShare[] }) {
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
  const url = apiUrl(`/api/${type}/${id}`);
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST", headers: { "content-type": file.type || "application/octet-stream", "x-file-name": encodeURIComponent(fileName) }, body: file,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || `The local API returned HTTP ${response.status}`);
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  const detail = lastError instanceof Error ? lastError.message : "The network request failed";
  throw new Error(`Could not upload “${fileName}”. ${detail} Check that Demolition is running and that its local API is reachable.`);
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

function durationSeconds(value: string) {
  const parts = value.split(":").map(Number);
  if (parts.length !== 2 || parts.some((part) => !Number.isFinite(part))) return 0;
  return Math.max(0, parts[0] * 60 + parts[1]);
}

function formatRuntime(seconds: number) {
  if (!seconds) return "00:00";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m ${String(remainingSeconds).padStart(2, "0")}s`;
}

function knownMusicalKey(value?: string) {
  const normalized = value?.trim() ?? "";
  return Boolean(normalized && normalized !== "—" && normalized !== "-");
}

function statsFilterDimension(filter: StatsFilter) {
  if (filter.type === "duration" || filter.type === "duration-min" || filter.type === "duration-max") return "duration";
  if (filter.type === "bpm" || filter.type === "bpm-exact" || filter.type === "bpm-min" || filter.type === "bpm-max") return "bpm";
  return filter.type;
}

function hasStatsFilter(filters: StatsFilter[], type: StatsFilter["type"], value: string) {
  return filters.some((filter) => filter.type === type && filter.value === value);
}

function matchesStatsFilter(demo: Demo, filter?: StatsFilter) {
  if (!filter) return true;
  if (filter.type === "project") return demo.project === filter.value;
  if (filter.type === "status") return demo.status === filter.value;
  if (filter.type === "date") return Boolean(demo.creationDate?.startsWith(filter.value));
  if (filter.type === "key") return (demo.key?.trim() ?? "") === filter.value;
  if (filter.type === "bpm-exact") return demo.bpm === Number(filter.value);
  if (filter.type === "bpm-min") return demo.bpm > 0 && demo.bpm >= Number(filter.value);
  if (filter.type === "bpm-max") return demo.bpm > 0 && demo.bpm <= Number(filter.value);
  if (filter.type === "bpm") {
    if (!demo.bpm) return false;
    return filter.value === "low" ? demo.bpm < 90
      : filter.value === "mid" ? demo.bpm >= 90 && demo.bpm < 120
        : filter.value === "standard" ? demo.bpm >= 120 && demo.bpm < 140
          : filter.value === "fast" ? demo.bpm >= 140 && demo.bpm < 160 : demo.bpm >= 160;
  }
  const seconds = durationSeconds(demo.duration);
  if (filter.type === "duration-min") return seconds > 0 && seconds >= Number(filter.value);
  if (filter.type === "duration-max") return seconds > 0 && seconds <= Number(filter.value);
  return filter.value === "over2" ? seconds > 120
    : filter.value === "short" ? seconds > 0 && seconds < 120
      : filter.value === "medium" ? seconds >= 120 && seconds < 240
        : filter.value === "long" ? seconds >= 240 && seconds < 420 : seconds >= 420;
}

function matchesStatsFilters(demo: Demo, filters: StatsFilter[]) {
  return filters.every((filter) => matchesStatsFilter(demo, filter));
}

function filenameKey(value: string) {
  return value.normalize("NFKC").replace(/\.[^.]+$/, "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
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

const keyNames = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const majorKeyProfile = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const minorKeyProfile = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function fastFourierTransform(real: Float64Array, imaginary: Float64Array) {
  let permutation = 0;
  for (let index = 1; index < real.length; index++) {
    let bit = real.length >> 1;
    for (; permutation & bit; bit >>= 1) permutation ^= bit;
    permutation ^= bit;
    if (index < permutation) {
      [real[index], real[permutation]] = [real[permutation], real[index]];
      [imaginary[index], imaginary[permutation]] = [imaginary[permutation], imaginary[index]];
    }
  }
  for (let size = 2; size <= real.length; size <<= 1) {
    const halfSize = size >> 1;
    const angle = -2 * Math.PI / size;
    const phaseReal = Math.cos(angle);
    const phaseImaginary = Math.sin(angle);
    for (let start = 0; start < real.length; start += size) {
      let multiplierReal = 1;
      let multiplierImaginary = 0;
      for (let offset = 0; offset < halfSize; offset++) {
        const even = start + offset;
        const odd = even + halfSize;
        const transformedReal = multiplierReal * real[odd] - multiplierImaginary * imaginary[odd];
        const transformedImaginary = multiplierReal * imaginary[odd] + multiplierImaginary * real[odd];
        real[odd] = real[even] - transformedReal;
        imaginary[odd] = imaginary[even] - transformedImaginary;
        real[even] += transformedReal;
        imaginary[even] += transformedImaginary;
        const nextMultiplierReal = multiplierReal * phaseReal - multiplierImaginary * phaseImaginary;
        multiplierImaginary = multiplierReal * phaseImaginary + multiplierImaginary * phaseReal;
        multiplierReal = nextMultiplierReal;
      }
    }
  }
}

function profileCorrelation(values: Float64Array, profile: number[], root: number) {
  let valuesMean = 0;
  let profileMean = 0;
  for (let interval = 0; interval < 12; interval++) {
    valuesMean += values[(root + interval) % 12];
    profileMean += profile[interval];
  }
  valuesMean /= 12;
  profileMean /= 12;
  let numerator = 0;
  let valuesVariance = 0;
  let profileVariance = 0;
  for (let interval = 0; interval < 12; interval++) {
    const value = values[(root + interval) % 12] - valuesMean;
    const expected = profile[interval] - profileMean;
    numerator += value * expected;
    valuesVariance += value * value;
    profileVariance += expected * expected;
  }
  return numerator / Math.sqrt(valuesVariance * profileVariance || 1);
}

async function detectMusicalKey(file: Blob): Promise<string | undefined> {
  const AudioContextClass = window.AudioContext;
  if (!AudioContextClass) return undefined;
  const context = new AudioContextClass();
  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    const fftSize = 4096;
    const maximumStart = Math.max(0, buffer.length - fftSize);
    const frameCount = Math.min(180, Math.max(1, Math.ceil(buffer.duration / 1.5)));
    const chroma = new Float64Array(12);
    const real = new Float64Array(fftSize);
    const imaginary = new Float64Array(fftSize);
    const binFrequency = buffer.sampleRate / fftSize;
    for (let frame = 0; frame < frameCount; frame++) {
      const start = frameCount === 1 ? 0 : Math.floor(maximumStart * frame / (frameCount - 1));
      real.fill(0);
      imaginary.fill(0);
      for (let offset = 0; offset < fftSize; offset++) {
        const sampleIndex = Math.min(buffer.length - 1, start + offset);
        let sample = 0;
        for (let channel = 0; channel < buffer.numberOfChannels; channel++) sample += buffer.getChannelData(channel)[sampleIndex];
        sample /= Math.max(1, buffer.numberOfChannels);
        real[offset] = sample * (0.5 - 0.5 * Math.cos(2 * Math.PI * offset / (fftSize - 1)));
      }
      fastFourierTransform(real, imaginary);
      const frameChroma = new Float64Array(12);
      let frameEnergy = 0;
      for (let bin = Math.max(1, Math.floor(65 / binFrequency)); bin < Math.min(fftSize / 2, Math.ceil(1800 / binFrequency)); bin++) {
        const frequency = bin * binFrequency;
        const energy = real[bin] * real[bin] + imaginary[bin] * imaginary[bin];
        if (!energy) continue;
        const midi = Math.round(69 + 12 * Math.log2(frequency / 440));
        frameChroma[(midi % 12 + 12) % 12] += energy;
        frameEnergy += energy;
      }
      if (frameEnergy) for (let pitch = 0; pitch < 12; pitch++) chroma[pitch] += frameChroma[pitch] / frameEnergy;
    }
    if (!chroma.some((value) => value > 0)) return undefined;
    let bestKey = "";
    let bestScore = -Infinity;
    for (let root = 0; root < 12; root++) {
      for (const [mode, profile] of [["maj", majorKeyProfile], ["min", minorKeyProfile]] as const) {
        const score = profileCorrelation(chroma, profile, root);
        if (score > bestScore) { bestScore = score; bestKey = `${keyNames[root]} ${mode}`; }
      }
    }
    return bestKey || undefined;
  } catch {
    return undefined;
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

function PhoneRemote({ token }: { token: string }) {
  const [session, setSession] = useState<RemoteSession>();
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [seeking, setSeeking] = useState(false);
  const [seekDraft, setSeekDraft] = useState(0);

  useEffect(() => {
    let active = true;
    let timer = 0;
    async function poll() {
      try {
        const next = await apiRequest<RemoteSession>(`/api/remote/sessions/${encodeURIComponent(token)}`);
        if (!active) return;
        setSession(next);
        setError("");
        if (!seeking) setSeekDraft(Number(next.state.currentTime || 0));
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : "The desktop session is unavailable.");
      } finally {
        if (active) timer = window.setTimeout(poll, 500);
      }
    }
    poll();
    return () => { active = false; window.clearTimeout(timer); };
  }, [seeking, token]);

  async function send(command: RemoteCommand) {
    if (sending) return;
    setSending(true);
    try {
      const next = await apiRequest<RemoteSession>(`/api/remote/sessions/${encodeURIComponent(token)}/commands`, { method: "POST", body: JSON.stringify(command) });
      setSession(next);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The command could not be sent.");
    } finally {
      setSending(false);
    }
  }

  const state = session?.state;
  const duration = Number(state?.duration || 0);
  const currentTime = seeking ? seekDraft : Number(state?.currentTime || 0);
  if (!session && !error) return <main className="phone-remote phone-remote-loading"><span>✳</span><strong>Connecting to Listen mode…</strong></main>;
  if (!session) return <main className="phone-remote phone-remote-error"><span>×</span><strong>Remote unavailable</strong><p>{error}</p></main>;
  return <main className="phone-remote">
    <header><div><span className="brand-mark">✳</span><strong>demolition</strong></div><span className={`remote-connection ${error ? "error" : ""}`}>{error ? "Connection interrupted" : "Connected"}</span></header>
    <section className="phone-now-playing">
      <div className="eyebrow">DESKTOP PLAYBACK · {Number(state?.index || 0) + 1} / {Number(state?.total || 0)}</div>
      <h1>{state?.title || "Waiting for a track"}</h1>
      <p>{state?.bpm ? `${state.bpm} BPM` : "BPM —"} · {state?.musicalKey || "—"} · {formatDuration(duration)}</p>
      {!state?.active && <div className="phone-session-ended">Listen mode is not active on the computer.</div>}
    </section>
    <section className="phone-transport" aria-label="Desktop transport controls">
      <div className="phone-time"><strong>{formatDuration(currentTime)}</strong><span>{formatDuration(duration)}</span></div>
      <input type="range" min="0" max={duration || 0} step="0.1" value={Math.min(currentTime, duration || 0)} disabled={!state?.active || !duration} aria-label="Seek desktop playback" onPointerDown={() => setSeeking(true)} onChange={(event) => setSeekDraft(Number(event.target.value))} onPointerUp={(event) => { const seconds = Number(event.currentTarget.value); setSeeking(false); setSeekDraft(seconds); send({ type: "seek", seconds }); }} onKeyUp={(event) => { if (event.key.startsWith("Arrow")) send({ type: "seek", seconds: Number(event.currentTarget.value) }); }} />
      <div className="phone-nudge"><button disabled={!state?.active || sending} onClick={() => send({ type: "seek", seconds: Math.max(0, currentTime - 10) })}>−10s</button><button disabled={!state?.active || sending} onClick={() => send({ type: "seek", seconds: Math.min(duration, currentTime + 10) })}>+10s</button></div>
      <div className="phone-main-transport"><button disabled={!state?.active || !state.hasPrevious || sending} onClick={() => send({ type: "previous" })} aria-label="Previous track">←<small>Previous</small></button><button className="phone-play" disabled={!state?.active || sending} onClick={() => send({ type: "play-pause" })} aria-label={state?.playing ? "Pause desktop playback" : "Play desktop playback"}>{state?.playing ? "Ⅱ" : "▶"}</button><button disabled={!state?.active || !state.hasNext || sending} onClick={() => send({ type: "next" })} aria-label="Next track">→<small>Next</small></button></div>
    </section>
    <section className="phone-score" aria-label="Score this track">
      <div><span>SCORE</span><strong>{Number(state?.score || 0) > 0 ? `+${state?.score}` : state?.score || 0}</strong><small>{state?.up || 0} up · {state?.down || 0} down</small></div>
      <div className="phone-votes"><button className={state?.vote === "down" ? "selected" : ""} aria-pressed={state?.vote === "down"} disabled={!state?.active || sending} onClick={() => send({ type: "down" })}><b>↓</b><span>Thumbs down</span></button><button className={state?.vote === "up" ? "selected" : ""} aria-pressed={state?.vote === "up"} disabled={!state?.active || sending} onClick={() => send({ type: "up" })}><b>↑</b><span>Thumbs up</span></button></div>
    </section>
    <button className="phone-skip" disabled={!state?.active || !state.hasNext || sending} onClick={() => send({ type: "skip" })}>Skip without rating <span>→</span></button>
    <footer>Audio remains on the computer.</footer>
  </main>;
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
  const [projectShares, setProjectShares] = useState<ProjectShare[]>([]);
  const [selectedDemoIds, setSelectedDemoIds] = useState<Set<number>>(new Set());
  const [showBulkShare, setShowBulkShare] = useState(false);
  const [bulkShareFriendIds, setBulkShareFriendIds] = useState<string[]>([]);
  const [bulkShareProgress, setBulkShareProgress] = useState("");
  const [mediaUrls, setMediaUrls] = useState<Record<number, string>>({});
  const [orders, setOrders] = useState<Record<string, number[]>>({});
  const [view, setView] = useState<View>("library");
  const [feedbackFilter, setFeedbackFilter] = useState<FeedbackFilter>("all");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [project, setProject] = useState("All demos");
  const [filter, setFilter] = useState("All");
  const [statsFilters, setStatsFilters] = useState<StatsFilter[]>([]);
  const [auditionBpmMin, setAuditionBpmMin] = useState("");
  const [auditionBpmMax, setAuditionBpmMax] = useState("");
  const [auditionKey, setAuditionKey] = useState("");
  const [auditionDurationMin, setAuditionDurationMin] = useState("");
  const [auditionDurationMax, setAuditionDurationMax] = useState("");
  const [auditionProject, setAuditionProject] = useState("All demos");
  const [auditionStatus, setAuditionStatus] = useState<Status | "">("");
  const [tagFilter, setTagFilter] = useState("All tags");
  const [statsComparisonMode, setStatsComparisonMode] = useState<StatsComparisonMode>("projects");
  const [statsTrendMetric, setStatsTrendMetric] = useState<StatsTrendMetric>("count");
  const [statsProjectA, setStatsProjectA] = useState("All demos");
  const [statsProjectB, setStatsProjectB] = useState("All demos");
  const [statsSharedFrom, setStatsSharedFrom] = useState("");
  const [statsSharedTo, setStatsSharedTo] = useState("");
  const [statsDateProject, setStatsDateProject] = useState("All demos");
  const [statsPeriodAFrom, setStatsPeriodAFrom] = useState("");
  const [statsPeriodATo, setStatsPeriodATo] = useState("");
  const [statsPeriodBFrom, setStatsPeriodBFrom] = useState("");
  const [statsPeriodBTo, setStatsPeriodBTo] = useState("");
  const [selectedId, setSelectedId] = useState(1);
  const [showAdd, setShowAdd] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const [bulkProgress, setBulkProgress] = useState("");
  const [pendingBulkImport, setPendingBulkImport] = useState<PendingBulkImport>();
  const [showConflictReview, setShowConflictReview] = useState(false);
  const [conflictProgress, setConflictProgress] = useState("");
  const [conflictExistingUrl, setConflictExistingUrl] = useState<string>();
  const [conflictIncomingUrl, setConflictIncomingUrl] = useState<string>();
  const [finalizingConflicts, setFinalizingConflicts] = useState(false);
  const [showBulkDetect, setShowBulkDetect] = useState(false);
  const [detectProgress, setDetectProgress] = useState("");
  const [showKeyDetect, setShowKeyDetect] = useState(false);
  const [keyDetectProgress, setKeyDetectProgress] = useState("");
  const [showStorage, setShowStorage] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const [syncingFriendIds, setSyncingFriendIds] = useState<string[]>([]);
  const [pairingCode, setPairingCode] = useState("");
  const [meshProgress, setMeshProgress] = useState("");
  const [storageInfo, setStorageInfo] = useState<StorageInfo>({ usage: 0, quota: 0, persisted: false });
  const [storageProgress, setStorageProgress] = useState("");
  const [rapidMode, setRapidMode] = useState(false);
  const [remoteToken, setRemoteToken] = useState("");
  const [remoteSession, setRemoteSession] = useState<RemoteSession>();
  const [showPhoneRemote, setShowPhoneRemote] = useState(false);
  const [remoteBaseUrl, setRemoteBaseUrl] = useState("");
  const [remotePairingUrl, setRemotePairingUrl] = useState("");
  const [remoteQrData, setRemoteQrData] = useState("");
  const [remoteStatus, setRemoteStatus] = useState("");
  const [rapidIndex, setRapidIndex] = useState(0);
  const [rapidIds, setRapidIds] = useState<number[]>([]);
  const [rapidNote, setRapidNote] = useState("");
  const [rapidVote, setRapidVote] = useState<"up" | "down">();
  const [rapidVoteEventUuid, setRapidVoteEventUuid] = useState<string>();
  const [rapidDuration, setRapidDuration] = useState(0);
  const [rapidCurrentTime, setRapidCurrentTime] = useState(0);
  const [rapidPlaying, setRapidPlaying] = useState(false);
  const [rapidFullPlaybackComplete, setRapidFullPlaybackComplete] = useState(false);
  const [trimDraft, setTrimDraft] = useState<{ start: number; end: number }>();
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
  const [todayLabel, setTodayLabel] = useState("");
  const [sortBy, setSortBy] = useState<"score" | "updated" | "created-new" | "created-old" | "title">("updated");
  const [audioUrl, setAudioUrl] = useState<string>();
  const [playbackError, setPlaybackError] = useState("");
  const [rapidPreloadUrl, setRapidPreloadUrl] = useState<string>();
  const [ready, setReady] = useState(false);
  const [draggedId, setDraggedId] = useState<number>();
  const importRef = useRef<HTMLInputElement>(null);
  const attachRef = useRef<HTMLInputElement>(null);
  const detailAudioRef = useRef<HTMLAudioElement>(null);
  const rapidAudioRef = useRef<HTMLAudioElement>(null);
  const rapidPreloadAudioRef = useRef<HTMLAudioElement>(null);
  const annotationRailRef = useRef<HTMLDivElement>(null);
  const annotationDragStartRef = useRef<number | undefined>(undefined);
  const trimDragRef = useRef<"start" | "end" | undefined>(undefined);
  const rapidTrimPlaybackRef = useRef(false);
  const waveformCacheRef = useRef(new Map<string, number[]>());
  const rapidAudioCacheRef = useRef(new Map<number, RapidAudioEntry>());
  const rapidAudioFetchesRef = useRef(new Map<number, Promise<RapidAudioEntry | undefined>>());
  const rapidAudioSessionRef = useRef(0);
  const rapidActionsRef = useRef({ previous: () => undefined, next: () => undefined, down: () => undefined, up: () => undefined });
  const remoteCommandActionsRef = useRef<(command: RemoteCommand) => void>(() => undefined);
  const remoteLastCommandRef = useRef(0);
  const remoteStateRef = useRef<RemotePlaybackState | undefined>(undefined);
  const activeFilenameConflict = pendingBulkImport?.conflicts[0];
  const conflictExistingDemo = activeFilenameConflict?.existing.kind === "demo" ? demos.find((demo) => demo.id === activeFilenameConflict.existing.demoId) : undefined;
  const conflictExistingIncoming = activeFilenameConflict?.existing.kind === "incoming" ? activeFilenameConflict.existing.audio : undefined;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setRemoteToken(new URLSearchParams(window.location.search).get("remote") || "");
      setTodayLabel(new Intl.DateTimeFormat("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date()).toUpperCase());
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!remoteSession || !remoteBaseUrl) return;
    let active = true;
    try {
      const url = new URL(remoteBaseUrl);
      url.searchParams.set("remote", remoteSession.token);
      url.hash = "";
      const value = url.toString();
      queueMicrotask(() => { if (active) setRemotePairingUrl(value); });
      QRCode.toDataURL(value, { width: 360, margin: 1, errorCorrectionLevel: "M", color: { dark: "#151713", light: "#f0e1c2" } }).then((data) => {
        if (active) { setRemoteQrData(data); setRemoteStatus(""); }
      }).catch(() => { if (active) setRemoteStatus("The QR code could not be generated."); });
    } catch {
      queueMicrotask(() => { if (active) { setRemotePairingUrl(""); setRemoteQrData(""); setRemoteStatus("Enter a complete phone-accessible URL."); } });
    }
    return () => { active = false; };
  }, [remoteBaseUrl, remoteSession]);

  function clearRapidAudioCache() {
    for (const entry of rapidAudioCacheRef.current.values()) URL.revokeObjectURL(entry.url);
    rapidAudioCacheRef.current.clear();
    rapidAudioFetchesRef.current.clear();
  }

  function pruneRapidAudioCache(keepIds: number[]) {
    const keep = new Set(keepIds);
    for (const [demoId, entry] of rapidAudioCacheRef.current) {
      if (keep.has(demoId)) continue;
      URL.revokeObjectURL(entry.url);
      rapidAudioCacheRef.current.delete(demoId);
    }
  }

  function loadRapidAudio(demoId: number, session: number) {
    const cached = rapidAudioCacheRef.current.get(demoId);
    if (cached) return Promise.resolve(cached);
    const pending = rapidAudioFetchesRef.current.get(demoId);
    if (pending) return pending;
    const request = getAudio(demoId).then((blob) => {
      if (!blob || rapidAudioSessionRef.current !== session) return undefined;
      const entry = { blob, url: URL.createObjectURL(blob) };
      rapidAudioCacheRef.current.set(demoId, entry);
      return entry;
    }).catch(() => undefined).finally(() => {
      if (rapidAudioFetchesRef.current.get(demoId) === request) rapidAudioFetchesRef.current.delete(demoId);
    });
    rapidAudioFetchesRef.current.set(demoId, request);
    return request;
  }

  async function refreshStorageInfo() {
    const response = await fetch(apiUrl("/api/storage"));
    if (!response.ok) throw new Error("Could not read local storage information");
    setStorageInfo(await response.json());
  }

  async function libraryAudioChecksums(excludeDemoId?: number, onProgress?: (message: string) => void) {
    const checksums = new Set<string>();
    const updates = new Map<number, { checksum: string; fileSize: number; copyVerifiedAt: number }>();
    for (const demo of demos) {
      if (demo.id === excludeDemoId) continue;
      if (demo.checksum) checksums.add(demo.checksum);
    }
    const unindexed = demos.filter((demo) => demo.id !== excludeDemoId && demo.audioName && !demo.checksum);
    for (let index = 0; index < unindexed.length; index++) {
      const demo = unindexed[index];
      onProgress?.(`Indexing existing demo ${index + 1} of ${unindexed.length}: ${demo.title}`);
      const blob = await getAudio(demo.id).catch(() => undefined);
      if (!blob) continue;
      const checksum = await checksumBlob(blob);
      checksums.add(checksum);
      updates.set(demo.id, { checksum, fileSize: blob.size, copyVerifiedAt: Date.now() });
    }
    if (updates.size) setDemos((current) => current.map((demo) => {
      const update = updates.get(demo.id);
      return update ? { ...demo, ...update } : demo;
    }));
    return checksums;
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
            projectShares: Array.isArray(legacy.projectShares) ? legacy.projectShares : [],
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
        setProjectShares(data.projectShares ?? []);
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
      saveWorkspace({ demos, projects, tags, orders, media, listens, timedNotes, shares, projectShares }).catch(() => {
        setImportNotice("Changes could not be saved to SQLite. Check that the local server is running.");
      });
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [demos, projects, tags, orders, media, listens, timedNotes, shares, projectShares, ready]);

  const selectedAudioDemo = demos.find((demo) => demo.id === selectedId);
  const selectedAudioChecksum = selectedAudioDemo?.checksum;
  const selectedAudioFileSize = selectedAudioDemo?.fileSize;
  const selectedAudioName = selectedAudioDemo?.audioName;

  useEffect(() => {
    const session = rapidAudioSessionRef.current + 1;
    rapidAudioSessionRef.current = session;
    if (!rapidMode) {
      clearRapidAudioCache();
      return;
    }
    clearRapidAudioCache();
    return () => {
      if (rapidAudioSessionRef.current !== session) return;
      rapidAudioSessionRef.current++;
      clearRapidAudioCache();
    };
  }, [rapidMode]);

  useEffect(() => {
    let active = true;
    if (!selectedAudioName) {
      queueMicrotask(() => {
        if (!active) return;
        setAudioUrl(undefined);
        setPlaybackError("");
        setWaveform([]);
        setDetailCurrentTime(0);
      });
      return () => { active = false; };
    }
    if (!rapidMode) {
      queueMicrotask(() => {
        if (!active) return;
        setAudioUrl(apiUrl(`/api/audio/${selectedId}`));
        setPlaybackError("");
        setWaveform([]);
        setDetailCurrentTime(0);
      });
      return () => { active = false; };
    }
    const cachedAudio = rapidAudioCacheRef.current.get(selectedId);
    queueMicrotask(() => {
      if (!active) return;
      setPlaybackError("");
      setDetailCurrentTime(0);
      setAudioUrl(cachedAudio?.url || apiUrl(`/api/audio/${selectedId}`));
      setWaveform([]);
    });
    const audioBlob = cachedAudio ? Promise.resolve(cachedAudio.blob) : getAudio(selectedId);
    audioBlob.then((blob) => {
      if (!active || !blob) return;
      const cacheKey = selectedAudioChecksum || `${selectedId}:${blob.size}`;
      const cached = waveformCacheRef.current.get(cacheKey);
      if (cached) setWaveform(cached);
      else {
        waveformPeaks(blob).then((peaks) => {
          if (!active) return;
          waveformCacheRef.current.set(cacheKey, peaks);
          setWaveform(peaks);
        });
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, [selectedId, selectedAudioChecksum, selectedAudioFileSize, selectedAudioName, rapidMode]);

  useEffect(() => {
    const player = rapidAudioRef.current;
    if (!rapidMode || !audioUrl || !player) return;
    rapidTrimPlaybackRef.current = false;
    setRapidFullPlaybackComplete(false);
    setRapidPlaying(false);
    player.pause();
    player.load();
    player.currentTime = 0;
    if (player.readyState >= 2) playRapidAudio(player);
  }, [audioUrl, rapidMode]);

  useEffect(() => {
    if (!rapidMode) return;
    const currentId = rapidIds[rapidIndex];
    const nextId = rapidIds[rapidIndex + 1];
    const previousId = rapidIds[rapidIndex - 1];
    const session = rapidAudioSessionRef.current;
    let active = true;
    pruneRapidAudioCache([currentId, nextId, previousId].filter((id): id is number => id !== undefined));
    queueMicrotask(() => { if (active) setRapidPreloadUrl(undefined); });
    if (nextId === undefined) return () => { active = false; };
    loadRapidAudio(nextId, session).then((entry) => {
      if (active && entry && rapidAudioSessionRef.current === session) setRapidPreloadUrl(entry.url);
    });
    return () => { active = false; };
  }, [rapidMode, rapidIds, rapidIndex]);

  useEffect(() => {
    if (!rapidPreloadUrl) return;
    rapidPreloadAudioRef.current?.load();
  }, [rapidPreloadUrl]);

  useEffect(() => {
    if (!activeFilenameConflict || !showConflictReview) return;
    let active = true;
    let existingUrl: string | undefined;
    const incomingUrl = URL.createObjectURL(activeFilenameConflict.incoming.file);
    queueMicrotask(() => {
      if (!active) return;
      setConflictIncomingUrl(incomingUrl);
      setConflictExistingUrl(undefined);
    });
    if (activeFilenameConflict.existing.kind === "incoming") {
      existingUrl = URL.createObjectURL(activeFilenameConflict.existing.audio.file);
      queueMicrotask(() => { if (active) setConflictExistingUrl(existingUrl); });
    } else {
      getAudio(activeFilenameConflict.existing.demoId).then((blob) => {
        if (!active || !blob) return;
        existingUrl = URL.createObjectURL(blob);
        setConflictExistingUrl(existingUrl);
      }).catch(() => undefined);
    }
    return () => {
      active = false;
      URL.revokeObjectURL(incomingUrl);
      if (existingUrl) URL.revokeObjectURL(existingUrl);
    };
  }, [activeFilenameConflict, showConflictReview]);

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
  const selectedDemos = demos.filter((demo) => selectedDemoIds.has(demo.id) && demo.ownerId === account?.id);
  const feedbackItems = useMemo<FeedbackItem[]>(() => {
    if (!account) return [];
    const titles = new Map(demos.map((demo) => [demo.id, demo.title]));
    const ratings: FeedbackItem[] = listens.filter((listen) => listen.authorId !== account.id).map((listen) => ({
      id: `rating-${listen.eventUuid || listen.id}`, kind: "rating", demoId: listen.demoId,
      demoTitle: titles.get(listen.demoId) || "Unavailable demo", authorName: listen.authorName || "Friend",
      text: listen.note || "No note attached", verdict: listen.verdict, createdAt: listen.listenedAt,
      receivedAt: listen.receivedAt || listen.listenedAt,
    }));
    const notes: FeedbackItem[] = timedNotes.filter((note) => note.authorId !== account.id).map((note) => ({
      id: `note-${note.noteUuid || note.id}`, kind: "note", demoId: note.demoId,
      demoTitle: titles.get(note.demoId) || "Unavailable demo", authorName: note.authorName || "Friend",
      text: note.note, startSeconds: note.startSeconds, endSeconds: note.endSeconds, createdAt: note.createdAt,
      receivedAt: note.receivedAt || note.createdAt,
    }));
    return [...ratings, ...notes].sort((a, b) => b.receivedAt - a.receivedAt || b.createdAt - a.createdAt);
  }, [account, demos, listens, timedNotes]);
  const unreadFeedbackCount = feedbackItems.filter((item) => item.receivedAt > (account?.feedbackSeenAt || 0)).length;
  const visibleFeedback = feedbackItems.filter((item) => {
    if (feedbackFilter === "ratings" && item.kind !== "rating") return false;
    if (feedbackFilter === "notes" && item.kind !== "note") return false;
    const query = search.trim().toLocaleLowerCase();
    return !query || `${item.demoTitle} ${item.authorName} ${item.text}`.toLocaleLowerCase().includes(query);
  });
  const revisitDemos = useMemo(() => demos.filter((demo) => demo.status === "revisit" || demo.status === "unheard").sort((a, b) => a.updatedAt - b.updatedAt), [demos]);
  const inProjects = demos.filter((demo) => demo.project !== "Unsorted").length;
  const projectNames = [...projects.map((item) => item.name), "Unsorted"];
  const currentProject = projects.find((item) => item.name === project);
  const projectMedia = media.filter((item) => item.project === project).sort((a, b) => b.createdAt - a.createdAt);
  const statsScopedDemos = useMemo(() => demos.filter((demo) => matchesStatsFilters(demo, statsFilters)), [demos, statsFilters]);
  const statsOverview = useMemo(() => {
    const audioCount = statsScopedDemos.filter((demo) => Boolean(demo.audioName)).length;
    const timedDemos = statsScopedDemos.map((demo) => ({ demo, seconds: durationSeconds(demo.duration) })).filter((item) => item.seconds > 0);
    const totalRuntime = timedDemos.reduce((total, item) => total + item.seconds, 0);
    const durationBuckets = [
      { value: "short", label: "Short", range: "Under 2 min", count: timedDemos.filter((item) => item.seconds < 120).length },
      { value: "medium", label: "Medium", range: "2–4 min", count: timedDemos.filter((item) => item.seconds >= 120 && item.seconds < 240).length },
      { value: "long", label: "Long", range: "4–7 min", count: timedDemos.filter((item) => item.seconds >= 240 && item.seconds < 420).length },
      { value: "epic", label: "Epic", range: "7 min and up", count: timedDemos.filter((item) => item.seconds >= 420).length },
    ];
    const bpmValues = statsScopedDemos.map((demo) => demo.bpm).filter((bpm) => Number.isFinite(bpm) && bpm > 0);
    const bpmCounts = new Map<number, number>();
    for (const bpm of bpmValues) bpmCounts.set(bpm, (bpmCounts.get(bpm) ?? 0) + 1);
    const commonBpm = [...bpmCounts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    const bpmBuckets = [
      { value: "low", label: "Low", range: "Under 90 BPM", count: bpmValues.filter((bpm) => bpm < 90).length },
      { value: "mid", label: "Mid", range: "90–119 BPM", count: bpmValues.filter((bpm) => bpm >= 90 && bpm < 120).length },
      { value: "standard", label: "Standard", range: "120–139 BPM", count: bpmValues.filter((bpm) => bpm >= 120 && bpm < 140).length },
      { value: "fast", label: "Fast", range: "140–159 BPM", count: bpmValues.filter((bpm) => bpm >= 140 && bpm < 160).length },
      { value: "very-fast", label: "Very fast", range: "160 BPM and up", count: bpmValues.filter((bpm) => bpm >= 160).length },
    ];
    const keyCounts = new Map<string, number>();
    for (const demo of statsScopedDemos) {
      const key = demo.key?.trim() ?? "";
      if (knownMusicalKey(key)) keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
    }
    const keys = [...keyCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const statusBreakdown = Object.entries(statusLabels).map(([status, label]) => ({ value: status, label, count: statsScopedDemos.filter((demo) => demo.status === status).length }));
    const projectCounts = new Map<string, number>();
    for (const demo of statsScopedDemos) projectCounts.set(demo.project, (projectCounts.get(demo.project) ?? 0) + 1);
    const projectBreakdown = [...projectCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const dateTrendMap = new Map<string, { month: string; label: string; count: number; runtime: number; bpmTotal: number; bpmCount: number }>();
    for (const demo of statsScopedDemos) {
      if (!demo.creationDate || !/^\d{4}-\d{2}-\d{2}$/.test(demo.creationDate)) continue;
      const month = demo.creationDate.slice(0, 7);
      const point = dateTrendMap.get(month) ?? {
        month,
        label: new Intl.DateTimeFormat("en-AU", { month: "short", year: "2-digit", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`)),
        count: 0,
        runtime: 0,
        bpmTotal: 0,
        bpmCount: 0,
      };
      point.count++;
      point.runtime += durationSeconds(demo.duration);
      if (Number.isFinite(demo.bpm) && demo.bpm > 0) { point.bpmTotal += demo.bpm; point.bpmCount++; }
      dateTrendMap.set(month, point);
    }
    const dateTrend = [...dateTrendMap.values()].sort((a, b) => a.month.localeCompare(b.month)).map((point) => ({
      ...point,
      averageBpm: point.bpmCount ? Math.round(point.bpmTotal / point.bpmCount) : 0,
    }));
    const longest = [...timedDemos].sort((a, b) => b.seconds - a.seconds)[0];
    return {
      audioCount,
      timedCount: timedDemos.length,
      totalRuntime,
      averageRuntime: timedDemos.length ? Math.round(totalRuntime / timedDemos.length) : 0,
      longest: longest?.demo,
      durationBuckets,
      durationMax: Math.max(1, ...durationBuckets.map((bucket) => bucket.count)),
      bpmValues,
      bpmCounts,
      commonBpm,
      bpmBuckets,
      bpmMax: Math.max(1, ...bpmBuckets.map((bucket) => bucket.count)),
      bpmAverage: bpmValues.length ? Math.round(bpmValues.reduce((total, bpm) => total + bpm, 0) / bpmValues.length) : 0,
      unknownBpm: statsScopedDemos.length - bpmValues.length,
      keys,
      keyMax: Math.max(1, ...(keys.length ? keys.map(([, count]) => count) : [0])),
      unknownKeys: statsScopedDemos.length - [...keyCounts.values()].reduce((total, count) => total + count, 0),
      statusBreakdown,
      statusMax: Math.max(1, ...statusBreakdown.map((item) => item.count)),
      projectBreakdown,
      projectMax: Math.max(1, ...(projectBreakdown.length ? projectBreakdown.map(([, count]) => count) : [0])),
      dateTrend,
      datedCount: dateTrend.reduce((total, point) => total + point.count, 0),
      dateTrendMaxCount: Math.max(1, ...dateTrend.map((point) => point.count)),
      dateTrendMaxRuntime: Math.max(1, ...dateTrend.map((point) => point.runtime)),
      dateTrendMaxBpm: Math.max(1, ...dateTrend.map((point) => point.averageBpm)),
    };
  }, [statsScopedDemos]);
  const statsFilteredDemos = statsScopedDemos;
  const statsAuditionDemos = statsFilteredDemos.filter((demo) => Boolean(demo.audioName));
  const statsProjectOptions = ["All demos", ...projectNames.filter((name) => name !== "All demos")];
  const statsComparison = useMemo(() => {
    function matchesProject(demo: Demo, scope: string) {
      return scope === "All demos" || demo.project === scope;
    }
    function matchesDates(demo: Demo, from: string, to: string) {
      if (from && (!demo.creationDate || demo.creationDate < from)) return false;
      if (to && (!demo.creationDate || demo.creationDate > to)) return false;
      return true;
    }
    function summarize(items: Demo[]) {
      const timed = items.map((demo) => durationSeconds(demo.duration)).filter((seconds) => seconds > 0);
      const bpms = items.map((demo) => demo.bpm).filter((bpm) => Number.isFinite(bpm) && bpm > 0);
      const counts = new Map<number, number>();
      for (const bpm of bpms) counts.set(bpm, (counts.get(bpm) ?? 0) + 1);
      const commonBpm = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
      const runtime = timed.reduce((total, seconds) => total + seconds, 0);
      return { count: items.length, runtime, average: timed.length ? Math.round(runtime / timed.length) : 0, commonBpm, bpmCount: bpms.length };
    }
    const scoped = (scope: string, from: string, to: string) => statsScopedDemos.filter((demo) => matchesProject(demo, scope) && matchesDates(demo, from, to));
    if (statsComparisonMode === "dates") {
      return {
        first: { label: "Period A", ...summarize(scoped(statsDateProject, statsPeriodAFrom, statsPeriodATo)) },
        second: { label: "Period B", ...summarize(scoped(statsDateProject, statsPeriodBFrom, statsPeriodBTo)) },
        note: `${statsDateProject} · creation dates only`,
      };
    }
    return {
      first: { label: statsProjectA, ...summarize(scoped(statsProjectA, statsSharedFrom, statsSharedTo)) },
      second: { label: statsProjectB, ...summarize(scoped(statsProjectB, statsSharedFrom, statsSharedTo)) },
      note: `${statsSharedFrom || statsSharedTo ? "Selected creation-date range" : "All creation dates"}`,
    };
  }, [statsScopedDemos, statsComparisonMode, statsProjectA, statsProjectB, statsSharedFrom, statsSharedTo, statsDateProject, statsPeriodAFrom, statsPeriodATo, statsPeriodBFrom, statsPeriodBTo]);
  const projectOrder = orders[project] ?? [];
  const projectCandidates = demos.filter((demo) => demo.project === project && !projectOrder.includes(demo.id));
  const rapidDemo = demos.find((demo) => demo.id === rapidIds[rapidIndex]);
  const rapidTrim = trimBounds();
  const rapidHasTrim = hasRapidTrim(rapidTrim);
  const rapidDisplayDuration = rapidDuration || (rapidDemo ? durationSeconds(rapidDemo.duration) : 0);
  const rapidTagOptions = rapidDemo ? [...tags].sort((a, b) => {
    const aSelected = rapidDemo.tags.some((tag) => tag.toLocaleLowerCase() === a.name.toLocaleLowerCase());
    const bSelected = rapidDemo.tags.some((tag) => tag.toLocaleLowerCase() === b.name.toLocaleLowerCase());
    return Number(bSelected) - Number(aSelected) || a.name.localeCompare(b.name);
  }) : [];
  const selectedStats = selected ? statsFor(selected.id) : statsFor(0);
  const selectedListens = selected ? listens.filter((listen) => listen.demoId === selected.id).slice(0, 5) : [];
  const selectedTimedNotes = selected ? timedNotes.filter((note) => note.demoId === selected.id).sort((a, b) => a.startSeconds - b.startSeconds) : [];
  const selectedOwnerScore = selected && account ? listens.filter((listen) => listen.demoId === selected.id && listen.authorId === account.id).reduce((score, listen) => score + (listen.verdict === "up" ? 1 : -1), 0) : 0;
  const selectedFriendScore = selected && account ? listens.filter((listen) => listen.demoId === selected.id && listen.authorId !== account.id).reduce((score, listen) => score + (listen.verdict === "up" ? 1 : -1), 0) : 0;
  const selectedScoresByPerson = selected ? [...listens.filter((listen) => listen.demoId === selected.id).reduce((scores, listen) => {
    const current = scores.get(listen.authorId) ?? { id: listen.authorId, name: listen.authorId === account?.id ? "You" : listen.authorName, up: 0, down: 0, score: 0 };
    if (listen.verdict === "up") current.up++;
    else current.down++;
    current.score = current.up - current.down;
    scores.set(listen.authorId, current);
    return scores;
  }, new Map<string, { id: string; name: string; up: number; down: number; score: number }>()).values()].sort((a, b) => Number(b.id === account?.id) - Number(a.id === account?.id) || b.score - a.score || a.name.localeCompare(b.name)) : [];
  const rapidStats = rapidDemo ? statsFor(rapidDemo.id) : statsFor(0);
  remoteStateRef.current = {
    active: Boolean(rapidMode && rapidDemo), title: rapidDemo?.title || "", bpm: rapidDemo?.bpm || 0,
    musicalKey: rapidDemo?.key || "—", duration: rapidDisplayDuration, currentTime: rapidCurrentTime,
    playing: rapidPlaying, index: rapidIndex, total: rapidIds.length, up: rapidStats.up, down: rapidStats.down,
    score: rapidStats.score, vote: rapidVote, hasPrevious: rapidIndex > 0, hasNext: rapidIndex < rapidIds.length - 1,
  };
  const rapidTimedNotes = rapidDemo ? timedNotes.filter((note) => note.demoId === rapidDemo.id).sort((a, b) => a.startSeconds - b.startSeconds) : [];
  const selectedActiveNoteUuids = new Set(selectedTimedNotes.filter((note) => detailCurrentTime >= note.startSeconds && detailCurrentTime <= note.endSeconds).map((note) => note.noteUuid));
  const rapidActiveNoteUuids = new Set(rapidTimedNotes.filter((note) => rapidCurrentTime >= note.startSeconds && rapidCurrentTime <= note.endSeconds).map((note) => note.noteUuid));
  const rapidDownSelected = rapidVote === "down";
  const rapidUpSelected = rapidVote === "up";
  const rapidQuickTags = rapidDemo ? <section className="rapid-tags" aria-label="Track tags"><div className="rapid-tags-head"><span>TAGS</span><small>Tap to apply or remove</small></div><div className="rapid-tag-list">{rapidTagOptions.map((tag) => { const selected = rapidDemo.tags.some((name) => name.toLocaleLowerCase() === tag.name.toLocaleLowerCase()); return <button key={tag.name} className={selected ? "selected" : ""} aria-pressed={selected} onClick={() => toggleRapidTag(tag.name)}><span>{selected ? "✓" : "+"}</span>{tag.name}</button>; })}{rapidTagOptions.length === 0 && <small>No tags created yet.</small>}</div><form className="rapid-tag-create" onSubmit={createAndApplyRapidTag}><input name="tag" aria-label="New tag" placeholder="New tag" autoComplete="off" /><button type="submit">Add</button></form></section> : null;
  const selectedListenHistory = selectedListens.length > 0 ? <div className="listen-history"><span className="eyebrow">RECENT LISTENS</span>{selectedListens.map((listen) => <div className={`listen-event ${listen.verdict}`} key={listen.eventUuid || listen.id}><b>{listen.verdict === "up" ? "↑" : "↓"}</b><span><i>{listen.authorId === account?.id ? "You" : listen.authorName}</i>{listen.note || "No note"}<small>{new Date(listen.listenedAt).toLocaleDateString("en-AU")}</small></span></div>)}</div> : null;
  const selectedScoreBreakdown = selectedScoresByPerson.length > 0 ? <div className="score-by-person"><span className="eyebrow">SCORE BY LISTENER</span>{selectedScoresByPerson.map((person) => <div key={person.id}><strong>{person.name}</strong><span>{person.up} up · {person.down} down</span><b>{person.score > 0 ? `+${person.score}` : person.score}</b></div>)}</div> : null;
  const selectedTimedNoteHistory = selectedTimedNotes.length > 0 ? <div className="timed-note-history"><span className="eyebrow">TIMED NOTES</span>{selectedTimedNotes.map((note) => <div className={`timed-note-history-row ${selectedActiveNoteUuids.has(note.noteUuid) ? "active" : ""}`} key={note.noteUuid}><button className="timed-note-jump" onClick={() => seekTimedNote(note)}><b>{formatDuration(note.startSeconds)}–{formatDuration(note.endSeconds)}</b><span><i>{note.authorId === account?.id ? "You" : note.authorName}</i>{note.note}</span></button>{note.authorId === account?.id && <div className="timed-note-actions"><button onClick={() => editTimedNote(note)}>Edit</button><button onClick={() => deleteTimedNote(note)}>Delete</button></div>}</div>)}</div> : null;
  const selectedSharing = selected && account ? selected.ownerId === account.id
    ? <div className="detail-section sharing-section"><div className="detail-section-head"><span>SHARED WITH</span><button onClick={() => setShowAccount(true)}>manage</button></div><div className="share-friends">{friends.map((friend) => { const direct = shares.some((share) => share.demoUuid === selected.uuid && share.friendId === friend.id); const inherited = projectShares.some((share) => share.project === selected.project && share.friendId === friend.id); const active = direct || inherited; return <button key={friend.id} className={active ? "shared" : ""} disabled={inherited} title={inherited ? `Shared through ${selected.project}` : undefined} onClick={() => toggleDemoShare(selected, friend.id)}><span>{active ? "✓" : "+"}</span>{friend.displayName}{inherited ? <small>project</small> : null}</button>; })}{friends.length === 0 && <small>No friends connected.</small>}</div></div>
    : <div className="detail-section remote-source"><div className="detail-section-head"><span>SHARED BY</span></div><p>{friends.find((friend) => friend.id === selected.ownerId)?.displayName || "Friend"}</p></div> : null;
  const rapidAnnotationTransport = audioUrl ? (
    <section className="annotation-transport">
      <div className="transport-controls">
        <button type="button" className="transport-play" onClick={toggleRapidPlayback} aria-label={rapidPlaying ? "Pause demo" : "Play demo"}>{rapidPlaying ? "Ⅱ" : "▶"}</button>
        <div><span>PLAYBACK</span><small>{rapidFullPlaybackComplete && rapidHasTrim ? "Trimmed replay" : "Full track"}</small></div>
        <strong>{formatDuration(rapidCurrentTime)} / {formatDuration(rapidDisplayDuration)}</strong>
      </div>
      <div className="transport-seek" aria-label="Track transport">
        <button type="button" onClick={() => nudgeRapid(-10)} disabled={!rapidDuration} aria-label="Seek back 10 seconds">−10s</button>
        <input type="range" min="0" max={rapidDuration || 0} step="0.1" value={rapidDuration ? Math.min(rapidCurrentTime, rapidDuration) : 0} onChange={(event) => seekRapid(Number(event.target.value))} disabled={!rapidDuration} aria-label="Seek through track" />
        <button type="button" onClick={() => nudgeRapid(10)} disabled={!rapidDuration} aria-label="Seek forward 10 seconds">+10s</button>
      </div>
      {playbackError && <small className="playback-error" role="status">{playbackError}</small>}
      <div className="annotation-head"><span>WAVEFORM &amp; TIMED NOTES</span><small>Scrub to skip · drag the orange handles to trim · drag the waveform to add a note</small></div>
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
        {rapidDuration > 0 && <>
          <span className="trim-muted trim-muted-start" style={{ width: `${rapidTrim.start / rapidDuration * 100}%` }} />
          <span className="trim-muted trim-muted-end" style={{ left: `${rapidTrim.end / rapidDuration * 100}%` }} />
          <span className="trim-active-range" style={{ left: `${rapidTrim.start / rapidDuration * 100}%`, width: `${(rapidTrim.end - rapidTrim.start) / rapidDuration * 100}%` }} />
          <button className="trim-handle trim-start" role="slider" aria-label="Trim start" aria-valuemin={0} aria-valuemax={rapidTrim.end} aria-valuenow={rapidTrim.start} aria-valuetext={formatDuration(rapidTrim.start)} style={{ left: `${rapidTrim.start / rapidDuration * 100}%` }} onPointerDown={(event) => beginTrimDrag("start", event)} onPointerMove={moveTrimDrag} onPointerUp={finishTrimDrag} onPointerCancel={() => { trimDragRef.current = undefined; }} onKeyDown={(event) => adjustTrimWithKeyboard("start", event)}><span>IN</span></button>
          <button className="trim-handle trim-end" role="slider" aria-label="Trim end" aria-valuemin={rapidTrim.start} aria-valuemax={rapidDuration} aria-valuenow={rapidTrim.end} aria-valuetext={formatDuration(rapidTrim.end)} style={{ left: `${rapidTrim.end / rapidDuration * 100}%` }} onPointerDown={(event) => beginTrimDrag("end", event)} onPointerMove={moveTrimDrag} onPointerUp={finishTrimDrag} onPointerCancel={() => { trimDragRef.current = undefined; }} onKeyDown={(event) => adjustTrimWithKeyboard("end", event)}><span>OUT</span></button>
        </>}
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
      <div className="trim-readout"><span>IN <b>{formatDuration(rapidTrim.start)}</b></span>{rapidHasTrim && <button onClick={resetRapidTrim}>Reset trim</button>}<span>OUT <b>{formatDuration(rapidTrim.end)}</b></span></div>
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
      const filterMatch = filter === "All" || (filter === "Favourites" ? demo.favorite : statusLabels[demo.status] === filter);
      const searchMatch = `${demo.title} ${demo.tags.join(" ")}`.toLowerCase().includes(search.toLowerCase());
      const tagMatch = tagFilter === "All tags" || demo.tags.some((tag) => tag.toLocaleLowerCase() === tagFilter.toLocaleLowerCase());
      const revisitMatch = view !== "revisit" || demo.status === "revisit" || demo.status === "unheard";
      const statsFilterMatch = matchesStatsFilters(demo, statsFilters);
      return projectMatch && filterMatch && tagMatch && searchMatch && revisitMatch && statsFilterMatch;
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
    } else {
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
  }, [demos, project, filter, statsFilters, tagFilter, search, view, orders, sortBy, listenStats]);

  function selectProject(name: string) {
    setStatsFilters([]);
    setProject(name);
    setView(name === "All demos" ? "library" : "project");
    setFilter("All");
    setProjectTab("tracklist");
  }

  function applyStatsFilter(next: StatsFilter) {
    const sameFilter = statsFilters.some((filter) => filter.type === next.type && filter.value === next.value);
    const dimension = statsFilterDimension(next);
    setStatsFilters(sameFilter
      ? statsFilters.filter((filter) => filter.type !== next.type || filter.value !== next.value)
      : [...statsFilters.filter((filter) => statsFilterDimension(filter) !== dimension), next]);
  }

  function applyAuditionFilters() {
    const nextFilters: StatsFilter[] = [];
    const numberValue = (raw: string) => {
      const value = Number(raw);
      return raw.trim() && Number.isFinite(value) && value > 0 ? String(value) : undefined;
    };
    const bpmMin = numberValue(auditionBpmMin);
    const bpmMax = numberValue(auditionBpmMax);
    const durationMin = numberValue(auditionDurationMin);
    const durationMax = numberValue(auditionDurationMax);
    if (bpmMin) nextFilters.push({ type: "bpm-min", value: bpmMin, label: `At least ${bpmMin} BPM` });
    if (bpmMax) nextFilters.push({ type: "bpm-max", value: bpmMax, label: `Up to ${bpmMax} BPM` });
    if (auditionKey) nextFilters.push({ type: "key", value: auditionKey, label: `${auditionKey} key` });
    if (durationMin) nextFilters.push({ type: "duration-min", value: durationMin, label: `At least ${formatDuration(Number(durationMin))} long` });
    if (durationMax) nextFilters.push({ type: "duration-max", value: durationMax, label: `Up to ${formatDuration(Number(durationMax))} long` });
    if (auditionProject !== "All demos") nextFilters.push({ type: "project", value: auditionProject, label: `${auditionProject} project` });
    if (auditionStatus) nextFilters.push({ type: "status", value: auditionStatus, label: `${statusLabels[auditionStatus]} demos` });
    const dimensions = new Set(nextFilters.map((filter) => statsFilterDimension(filter)));
    const mergedFilters = [...statsFilters.filter((filter) => !dimensions.has(statsFilterDimension(filter))), ...nextFilters];
    setStatsFilters(mergedFilters);
  }

  function closeMobileMenu() {
    setMobileMenuOpen(false);
  }

  async function openFeedback() {
    closeMobileMenu();
    setStatsFilters([]);
    setProject("All demos");
    setView("feedback");
    if (!account || !unreadFeedbackCount) return;
    const seenAt = Date.now();
    setAccount({ ...account, feedbackSeenAt: seenAt });
    const updated = await apiRequest<Account>("/api/feedback/seen", { method: "POST", body: JSON.stringify({ seenAt }) }).catch(() => undefined);
    if (updated) setAccount(updated);
  }

  function openFeedbackDemo(item: FeedbackItem) {
    if (!demos.some((demo) => demo.id === item.demoId)) return;
    setSelectedId(item.demoId);
    setProject("All demos");
    setFilter("All");
    setView("library");
  }

  function openEdit() {
    if (!selected) return;
    setEditTagsDraft(selected.tags.join(", "));
    setShowEdit(true);
  }

  function toggleFavorite(demoId: number) {
    setDemos((current) => current.map((demo) => demo.id === demoId ? { ...demo, favorite: !demo.favorite } : demo));
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
    if (checksum && (await libraryAudioChecksums()).has(checksum)) { window.alert("This audio file is already in Demolition."); return; }
    if (hasFile && storageInfo.quota && file.size > storageInfo.quota - storageInfo.usage) { window.alert("There is not enough disk space available for this copy."); return; }
    const title = String(form.get("title") || (hasFile ? file.name.replace(/\.[^.]+$/, "") : "Untitled demo"));
    const demoTags = parseTags(String(form.get("tags") || ""));
    if (hasFile && checksum) {
      const existing = demos.find((demo) => (!account || demo.ownerId === account.id) && demo.audioName && filenameKey(demo.audioName) === filenameKey(file.name));
      if (existing) {
        const incoming: PreparedAudio = {
          file, checksum, title,
          bpm: form.get("bpm") ? Number(form.get("bpm")) : undefined,
          musicalKey: String(form.get("key") || "—"),
        };
        setPendingBulkImport({
          destination: String(form.get("project") || "Unsorted"), batchTags: demoTags,
          newFiles: [], replacements: [],
          conflicts: [{ id: crypto.randomUUID(), existing: { kind: "demo", demoId: existing.id }, incoming }],
          exactDuplicates: 0, filenameSkipped: 0, skippedFiles: 0,
        });
        setConflictProgress("");
        setShowConflictReview(true);
        setShowAdd(false);
        return;
      }
    }
    const analysis = hasFile ? await analyzeAudio(file) : { duration: "00:00", bpm: 0 };
    const next: Demo = {
      id,
      uuid: crypto.randomUUID(),
      ownerId: account?.id ?? "",
      title,
      bpm: Number(form.get("bpm") || analysis.bpm),
      key: String(form.get("key") || "—"),
      duration: analysis.duration,
      status: "unheard",
      tags: demoTags,
      note: "",
      nextAction: "First proper listen",
      rating: 0,
      favorite: false,
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
    if ((await libraryAudioChecksums(selected.id)).has(checksum)) { window.alert("This audio is already attached to another demo."); return; }
    await putAudio(selected.id, file);
    const analysis = await analyzeAudio(file);
    setDemos((current) => current.map((demo) => demo.id === selected.id ? { ...demo, audioName: file.name, duration: analysis.duration, bpm: analysis.bpm || demo.bpm, checksum, fileSize: file.size, copyVerifiedAt: Date.now(), updatedAt: Date.now() } : demo));
    refreshStorageInfo().catch(() => undefined);
    event.target.value = "";
  }

  async function bulkImport(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await performBulkImport(event);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "The import could not be completed.";
      setBulkProgress(`Import stopped: ${detail}`);
    }
  }

  async function performBulkImport(event: React.FormEvent<HTMLFormElement>) {
    const form = new FormData(event.currentTarget);
    const destination = String(form.get("project") || "Unsorted");
    const batchTags = parseTags(String(form.get("tags") || ""));
    const candidates = [...form.getAll("files"), ...form.getAll("folder")].filter((item): item is File => item instanceof File && item.size > 0);
    const audioFiles = candidates.filter((file) => file.type.startsWith("audio/") || /\.(wav|aif|aiff|mp3|m4a|flac|ogg|opus|aac)$/i.test(file.name));
    const skippedFiles = candidates.length - audioFiles.length;
    if (!audioFiles.length) { setBulkProgress(`No supported audio files found. ${skippedFiles} other ${skippedFiles === 1 ? "file was" : "files were"} ignored.`); return; }
    const knownChecksums = await libraryAudioChecksums(undefined, setBulkProgress);
    const uniqueFiles: PreparedAudio[] = [];
    let duplicates = 0;
    for (let index = 0; index < audioFiles.length; index++) {
      const file = audioFiles[index];
      setBulkProgress(`Checking ${index + 1} of ${audioFiles.length}: ${file.name}`);
      const checksum = await checksumBlob(file);
      if (knownChecksums.has(checksum)) { duplicates++; continue; }
      knownChecksums.add(checksum);
      uniqueFiles.push({ file, checksum });
    }
    if (!uniqueFiles.length) { setBulkProgress(`Nothing new to import. ${duplicates} duplicate ${duplicates === 1 ? "file was" : "files were"} skipped.`); return; }
    const totalBytes = uniqueFiles.reduce((sum, item) => sum + item.file.size, 0);
    if (storageInfo.quota && totalBytes > (storageInfo.quota - storageInfo.usage) * 0.95) { setBulkProgress(`Not enough storage. The new files need ${formatBytes(totalBytes)}, but about ${formatBytes(Math.max(0, storageInfo.quota - storageInfo.usage))} is available.`); return; }
    const versionsByFilename = new Map<string, FilenameConflict["existing"]>();
    for (const demo of demos) {
      if (account && demo.ownerId !== account.id) continue;
      const key = filenameKey(demo.audioName || demo.title);
      if (key && demo.audioName && !versionsByFilename.has(key)) versionsByFilename.set(key, { kind: "demo", demoId: demo.id });
    }
    const newFiles: PreparedAudio[] = [];
    const conflicts: FilenameConflict[] = [];
    for (const incoming of uniqueFiles) {
      const key = filenameKey(incoming.file.name);
      const existing = versionsByFilename.get(key);
      if (existing) conflicts.push({ id: crypto.randomUUID(), existing, incoming });
      else {
        newFiles.push(incoming);
        versionsByFilename.set(key, { kind: "incoming", audio: incoming });
      }
    }
    const pending: PendingBulkImport = {
      destination, batchTags, newFiles, replacements: [], conflicts,
      exactDuplicates: duplicates, filenameSkipped: 0, skippedFiles,
    };
    if (conflicts.length) {
      setPendingBulkImport(pending);
      setConflictProgress("");
      setShowConflictReview(true);
      setBulkProgress("");
      setShowBulk(false);
      return;
    }
    await finalizeBulkImport(pending, setBulkProgress);
  }

  async function finalizeBulkImport(pending: PendingBulkImport, reportProgress: (message: string) => void) {
    let imported = 0;
    let firstChangedId: number | undefined;
    for (let index = 0; index < pending.replacements.length; index++) {
      const replacement = pending.replacements[index];
      const existing = demos.find((demo) => demo.id === replacement.demoId);
      if (!existing) continue;
      reportProgress(`Replacing ${index + 1} of ${pending.replacements.length}: ${existing.title}`);
      const analysis = await analyzeAudio(replacement.file);
      await putAudio(existing.id, replacement.file);
      const updatedAt = Date.now();
      setDemos((current) => current.map((demo) => demo.id === existing.id ? {
        ...demo, audioName: replacement.file.name, duration: analysis.duration,
        bpm: analysis.bpm || demo.bpm, checksum: replacement.checksum,
        fileSize: replacement.file.size, copyVerifiedAt: updatedAt, updatedAt,
      } : demo));
      firstChangedId ??= existing.id;
    }
    const usedIds = new Set(demos.map((demo) => demo.id));
    let nextId = Date.now();
    for (let index = 0; index < pending.newFiles.length; index++) {
      const prepared = pending.newFiles[index];
      const { file, checksum } = prepared;
      reportProgress(`Importing ${index + 1} of ${pending.newFiles.length}: ${file.name}`);
      while (usedIds.has(nextId)) nextId++;
      const id = nextId++;
      usedIds.add(id);
      const analysis = await analyzeAudio(file);
      await putAudio(id, file);
      const title = prepared.title || file.name.replace(/\.[^.]+$/, "");
      const demo: Demo = {
        id, uuid: crypto.randomUUID(), ownerId: account?.id ?? "", title, bpm: prepared.bpm ?? analysis.bpm, key: prepared.musicalKey || "—", duration: analysis.duration,
        status: "unheard", tags: pending.batchTags, note: "", nextAction: "First proper listen",
        rating: 0, favorite: false, project: pending.destination, updatedAt: Date.now(), audioName: file.name,
        checksum, fileSize: file.size, copyVerifiedAt: Date.now(), creationDate: extractCreationDate(title),
      };
      imported++;
      setDemos((current) => [demo, ...current]);
      firstChangedId ??= id;
    }
    if (imported) setTags((current) => mergeTags(current, pending.batchTags));
    if (firstChangedId !== undefined) setSelectedId(firstChangedId);
    setProject(pending.destination === "Unsorted" ? "All demos" : pending.destination);
    setView(pending.destination === "Unsorted" ? "library" : "project");
    setProjectTab("tracklist");
    const parts = [
      imported ? `${imported} ${imported === 1 ? "demo" : "demos"} imported` : "",
      pending.replacements.length ? `${pending.replacements.length} ${pending.replacements.length === 1 ? "demo" : "demos"} replaced` : "",
      pending.exactDuplicates ? `${pending.exactDuplicates} exact ${pending.exactDuplicates === 1 ? "duplicate" : "duplicates"} skipped` : "",
      pending.filenameSkipped ? `${pending.filenameSkipped} filename ${pending.filenameSkipped === 1 ? "conflict" : "conflicts"} kept existing` : "",
      pending.skippedFiles ? `${pending.skippedFiles} non-audio ${pending.skippedFiles === 1 ? "file" : "files"} ignored` : "",
    ].filter(Boolean);
    setImportNotice(`${parts.join(" · ")}.`);
    setBulkProgress("");
    setConflictProgress("");
    setPendingBulkImport(undefined);
    setShowConflictReview(false);
    setShowBulk(false);
    setFinalizingConflicts(false);
    refreshStorageInfo().catch(() => undefined);
  }

  async function resolveFilenameConflict(decision: "existing" | "incoming" | "both") {
    if (!pendingBulkImport || !activeFilenameConflict || finalizingConflicts) return;
    let remaining = pendingBulkImport.conflicts.slice(1);
    if (decision === "incoming" && activeFilenameConflict.existing.kind === "incoming") {
      const previousChecksum = activeFilenameConflict.existing.audio.checksum;
      remaining = remaining.map((conflict) => conflict.existing.kind === "incoming" && conflict.existing.audio.checksum === previousChecksum
        ? { ...conflict, existing: { kind: "incoming" as const, audio: activeFilenameConflict.incoming } }
        : conflict);
    }
    const next: PendingBulkImport = {
      ...pendingBulkImport,
      conflicts: remaining,
      newFiles: decision === "both" ? [...pendingBulkImport.newFiles, activeFilenameConflict.incoming] : pendingBulkImport.newFiles,
      replacements: decision === "incoming" && activeFilenameConflict.existing.kind === "demo" ? [...pendingBulkImport.replacements, { ...activeFilenameConflict.incoming, demoId: activeFilenameConflict.existing.demoId }] : pendingBulkImport.replacements,
      filenameSkipped: decision === "existing" ? pendingBulkImport.filenameSkipped + 1 : pendingBulkImport.filenameSkipped,
    };
    if (decision === "incoming" && activeFilenameConflict.existing.kind === "incoming") {
      const previousChecksum = activeFilenameConflict.existing.audio.checksum;
      next.newFiles = next.newFiles.map((item) => item.checksum === previousChecksum ? activeFilenameConflict.incoming : item);
    }
    if (remaining.length) {
      setPendingBulkImport(next);
      return;
    }
    setPendingBulkImport(next);
    setFinalizingConflicts(true);
    try {
      await finalizeBulkImport(next, setConflictProgress);
    } catch (error) {
      setConflictProgress(error instanceof Error ? error.message : "The import could not be completed.");
      setFinalizingConflicts(false);
    }
  }

  function deferFilenameConflicts() {
    if (finalizingConflicts) return;
    setShowConflictReview(false);
    setConflictProgress("");
  }

  function openBulkImport() {
    if (pendingBulkImport?.conflicts.length) {
      setShowConflictReview(true);
      return;
    }
    setBulkProgress("");
    setShowBulk(true);
  }

  function openSingleImport() {
    if (pendingBulkImport?.conflicts.length) {
      setShowConflictReview(true);
      return;
    }
    setShowAdd(true);
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

  async function bulkDetectKeys(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const scope = String(form.get("scope") || "library");
    const mode = String(form.get("mode") || "missing");
    let targets = demos.filter((demo) => (scope === "library" || demo.project === project) && Boolean(demo.audioName));
    if (mode === "missing") targets = targets.filter((demo) => !knownMusicalKey(demo.key));
    if (!targets.length) { setKeyDetectProgress("No demos with local audio match this selection."); return; }
    let detected = 0;
    let noAudio = 0;
    let uncertain = 0;
    for (let index = 0; index < targets.length; index++) {
      const demo = targets[index];
      setKeyDetectProgress(`Analyzing ${index + 1} of ${targets.length}: ${demo.title}`);
      const blob = await getAudio(demo.id).catch(() => undefined);
      if (!blob) { noAudio++; continue; }
      const musicalKey = await detectMusicalKey(blob);
      if (!musicalKey) { uncertain++; continue; }
      detected++;
      setDemos((current) => current.map((item) => item.id === demo.id ? { ...item, key: musicalKey, updatedAt: Date.now() } : item));
    }
    setImportNotice(`${detected} ${detected === 1 ? "demo" : "demos"} received a key estimate${noAudio ? ` · ${noAudio} missing a local copy` : ""}${uncertain ? ` · ${uncertain} were too ambiguous to classify` : ""}.`);
    setKeyDetectProgress("");
    setShowKeyDetect(false);
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

  function startRapidListen(sourceDemos = demos) {
    const playableDemos = sourceDemos.filter((demo) => demo.audioName);
    const ids = [...playableDemos].sort((a, b) => {
      const aStats = statsFor(a.id);
      const bStats = statsFor(b.id);
      return aStats.count - bStats.count || (aStats.lastAt ?? 0) - (bStats.lastAt ?? 0) || a.updatedAt - b.updatedAt;
    }).map((demo) => demo.id);
    if (!ids.length) { window.alert(sourceDemos === demos ? "Import some demos before starting listen mode." : "No matching demos have attached audio."); return; }
    setRapidPreloadUrl(undefined);
    setAudioUrl(undefined);
    setRapidIds(ids);
    setRapidIndex(0);
    resetRapidResponse();
    setSelectedId(ids[0]);
    setRapidMode(true);
  }

  async function openPhoneRemote() {
    setShowPhoneRemote(true);
    setRemoteStatus("Preparing phone remote…");
    if (!remoteBaseUrl) setRemoteBaseUrl(window.location.origin);
    if (remoteSession && remoteSession.expiresAt > Date.now()) { setRemoteStatus(""); return; }
    try {
      const session = await apiRequest<RemoteSession>("/api/remote/sessions", { method: "POST", body: "{}" });
      remoteLastCommandRef.current = session.commandSequence;
      setRemoteSession(session);
      setRemoteStatus("");
    } catch (error) {
      setRemoteStatus(error instanceof Error ? error.message : "The phone remote could not be created.");
    }
  }

  async function closePhoneRemote() {
    const token = remoteSession?.token;
    setRemoteSession(undefined);
    setRemoteQrData("");
    setRemotePairingUrl("");
    setShowPhoneRemote(false);
    if (token) await apiRequest(`/api/remote/sessions/${encodeURIComponent(token)}`, { method: "DELETE" }).catch(() => undefined);
  }

  function resetRapidResponse() {
    setRapidNote("");
    setRapidVote(undefined);
    setRapidVoteEventUuid(undefined);
    setRapidCurrentTime(0);
    setRapidDuration(0);
    setRapidPlaying(false);
    setRapidFullPlaybackComplete(false);
    setTrimDraft(undefined);
    setTimedNoteRange(undefined);
    setTimedNoteDraft("");
    setEditingTimedNoteUuid(undefined);
    annotationDragStartRef.current = undefined;
    trimDragRef.current = undefined;
    rapidTrimPlaybackRef.current = false;
  }

  function trimBounds(duration = rapidDuration, draft = trimDraft) {
    const start = Math.max(0, Math.min(draft?.start ?? rapidDemo?.trimStartSeconds ?? 0, Math.max(0, duration - 0.5)));
    const end = Math.max(start + Math.min(0.5, duration), Math.min(draft?.end ?? rapidDemo?.trimEndSeconds ?? duration, duration));
    return { start, end };
  }

  function hasRapidTrim(bounds = trimBounds()) {
    return rapidDuration > 0 && (bounds.start > 0.01 || bounds.end < rapidDuration - 0.01);
  }

  function handleRapidLoadedMetadata(player: HTMLAudioElement) {
    const duration = player.duration || 0;
    setRapidDuration(duration);
    setTrimDraft(trimBounds(duration, {
      start: rapidDemo?.trimStartSeconds ?? 0,
      end: rapidDemo?.trimEndSeconds ?? duration,
    }));
    if (rapidDemo && duration > 0 && rapidDemo.duration !== formatDuration(duration)) {
      setDemos((current) => current.map((demo) => demo.id === rapidDemo.id ? { ...demo, duration: formatDuration(duration) } : demo));
    }
  }

  function handleRapidTimeUpdate(player: HTMLAudioElement) {
    const currentTime = player.currentTime;
    const bounds = trimBounds();
    if (rapidTrimPlaybackRef.current && hasRapidTrim(bounds) && currentTime >= bounds.end) {
      player.pause();
      player.currentTime = bounds.start;
      rapidTrimPlaybackRef.current = false;
      setRapidCurrentTime(bounds.start);
      setRapidPlaying(false);
      return;
    }
    setRapidCurrentTime(currentTime);
  }

  function handleRapidEnded(player: HTMLAudioElement) {
    const bounds = trimBounds();
    rapidTrimPlaybackRef.current = false;
    setRapidPlaying(false);
    setRapidFullPlaybackComplete(true);
    player.currentTime = hasRapidTrim(bounds) ? bounds.start : 0;
    setRapidCurrentTime(player.currentTime);
  }

  function playRapidAudio(player: HTMLAudioElement) {
    player.play().then(() => {
      setRapidPlaying(true);
      setPlaybackError("");
    }).catch((error: unknown) => {
      setRapidPlaying(false);
      if (error instanceof DOMException && error.name === "NotAllowedError") return;
      setPlaybackError("This audio copy could not be decoded by the browser.");
    });
  }

  function toggleRapidPlayback() {
    const player = rapidAudioRef.current;
    if (!player) return;
    if (!player.paused) {
      player.pause();
      setRapidPlaying(false);
      return;
    }
    const bounds = trimBounds();
    if (rapidFullPlaybackComplete) {
      const shouldTrim = hasRapidTrim(bounds);
      rapidTrimPlaybackRef.current = shouldTrim;
      if (shouldTrim && (player.currentTime < bounds.start || player.currentTime >= bounds.end - 0.05)) player.currentTime = bounds.start;
      else if (!shouldTrim && player.currentTime >= rapidDuration - 0.05) player.currentTime = 0;
    } else {
      rapidTrimPlaybackRef.current = false;
    }
    playRapidAudio(player);
  }

  function seekRapid(seconds: number) {
    const player = rapidAudioRef.current;
    if (!player) return;
    const duration = Number.isFinite(player.duration) && player.duration > 0 ? player.duration : rapidDuration;
    if (!duration) return;
    const target = Math.max(0, Math.min(duration, seconds));
    rapidTrimPlaybackRef.current = false;
    setRapidFullPlaybackComplete(false);
    player.currentTime = target;
    setRapidCurrentTime(target);
  }

  function nudgeRapid(seconds: number) {
    const player = rapidAudioRef.current;
    seekRapid((player?.currentTime ?? rapidCurrentTime) + seconds);
  }

  function trimRangeAt(kind: "start" | "end", seconds: number) {
    const current = trimBounds();
    return kind === "start"
      ? { start: Math.max(0, Math.min(seconds, current.end - 0.5)), end: current.end }
      : { start: current.start, end: Math.min(rapidDuration, Math.max(seconds, current.start + 0.5)) };
  }

  function beginTrimDrag(kind: "start" | "end", event: React.PointerEvent<HTMLButtonElement>) {
    if (!rapidDuration || event.button !== 0) return;
    event.stopPropagation();
    trimDragRef.current = kind;
    setTrimDraft(trimRangeAt(kind, annotationSeconds(event.clientX)));
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveTrimDrag(event: React.PointerEvent<HTMLButtonElement>) {
    const kind = trimDragRef.current;
    if (!kind) return;
    event.stopPropagation();
    setTrimDraft(trimRangeAt(kind, annotationSeconds(event.clientX)));
  }

  function persistRapidTrim(range: { start: number; end: number }) {
    if (!rapidDemo || !rapidDuration) return;
    const isFullRange = range.start <= 0.01 && range.end >= rapidDuration - 0.01;
    setDemos((current) => current.map((demo) => demo.id === rapidDemo.id ? {
      ...demo,
      trimStartSeconds: isFullRange ? undefined : range.start,
      trimEndSeconds: isFullRange ? undefined : range.end,
    } : demo));
  }

  function finishTrimDrag(event: React.PointerEvent<HTMLButtonElement>) {
    const kind = trimDragRef.current;
    if (!kind) return;
    event.stopPropagation();
    const range = trimRangeAt(kind, annotationSeconds(event.clientX));
    setTrimDraft(range);
    persistRapidTrim(range);
    trimDragRef.current = undefined;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function adjustTrimWithKeyboard(kind: "start" | "end", event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    const current = trimBounds();
    const seconds = current[kind] + (event.key === "ArrowRight" ? 0.5 : -0.5);
    const range = trimRangeAt(kind, seconds);
    setTrimDraft(range);
    persistRapidTrim(range);
  }

  function resetRapidTrim() {
    if (!rapidDemo || !rapidDuration) return;
    const range = { start: 0, end: rapidDuration };
    setTrimDraft(range);
    persistRapidTrim(range);
    rapidTrimPlaybackRef.current = false;
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
    const previousId = rapidIds[previousIndex];
    const previousAudio = rapidAudioCacheRef.current.get(previousId);
    setAudioUrl(previousAudio?.url);
    setRapidIndex(previousIndex);
    setSelectedId(previousId);
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
    const nextId = rapidIds[nextIndex];
    const nextAudio = rapidAudioCacheRef.current.get(nextId);
    setAudioUrl(nextAudio?.url);
    setRapidIndex(nextIndex);
    setSelectedId(nextId);
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

  useEffect(() => {
    remoteCommandActionsRef.current = (command) => {
      if (!rapidMode) return;
      if (command.type === "play-pause") toggleRapidPlayback();
      else if (command.type === "previous") previousRapid();
      else if (command.type === "next" || command.type === "skip") advanceRapid();
      else if (command.type === "up") recordListen("up");
      else if (command.type === "down") recordListen("down");
      else if (command.type === "seek" && Number.isFinite(command.seconds)) seekRapid(Number(command.seconds));
    };
  });

  useEffect(() => {
    const token = remoteSession?.token;
    if (!token) return;
    let active = true;
    let timer = 0;
    async function publishAndPoll() {
      try {
        const session = await apiRequest<RemoteSession>(`/api/remote/sessions/${encodeURIComponent(token)}`, { method: "PUT", body: JSON.stringify({ state: remoteStateRef.current || { active: false }, afterSequence: remoteLastCommandRef.current }) });
        if (!active) return;
        setRemoteSession(session);
        setRemoteStatus("");
        const queued = (session.commands || []).find((item) => item.sequence > remoteLastCommandRef.current);
        if (queued) {
          remoteLastCommandRef.current = queued.sequence;
          remoteCommandActionsRef.current(queued.command);
        }
      } catch (error) {
        if (active) setRemoteStatus(error instanceof Error ? error.message : "The phone remote lost contact with the local server.");
      } finally {
        if (active) timer = window.setTimeout(publishAndPoll, 350);
      }
    }
    publishAndPoll();
    return () => { active = false; window.clearTimeout(timer); };
  }, [remoteSession?.token]);

  function changeRapidProject(nextProject: string) {
    if (!rapidDemo) return;
    const previousProject = rapidDemo.project;
    setDemos((current) => current.map((demo) => demo.id === rapidDemo.id ? { ...demo, project: nextProject, updatedAt: Date.now() } : demo));
    if (previousProject !== nextProject) setOrders((current) => ({ ...current, [previousProject]: (current[previousProject] ?? []).filter((id) => id !== rapidDemo.id) }));
  }

  function toggleRapidTag(name: string) {
    if (!rapidDemo) return;
    setDemos((current) => current.map((demo) => {
      if (demo.id !== rapidDemo.id) return demo;
      const selected = demo.tags.some((tag) => tag.toLocaleLowerCase() === name.toLocaleLowerCase());
      return { ...demo, tags: selected ? demo.tags.filter((tag) => tag.toLocaleLowerCase() !== name.toLocaleLowerCase()) : [...demo.tags, name], updatedAt: Date.now() };
    }));
  }

  function createAndApplyRapidTag(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!rapidDemo) return;
    const form = new FormData(event.currentTarget);
    const [enteredName] = parseTags(String(form.get("tag") || ""));
    if (!enteredName) return;
    const name = tags.find((tag) => tag.name.toLocaleLowerCase() === enteredName.toLocaleLowerCase())?.name ?? enteredName;
    setTags((current) => mergeTags(current, [name]));
    setDemos((current) => current.map((demo) => demo.id === rapidDemo.id && !demo.tags.some((tag) => tag.toLocaleLowerCase() === name.toLocaleLowerCase()) ? { ...demo, tags: [...demo.tags, name], updatedAt: Date.now() } : demo));
    event.currentTarget.reset();
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
      setProjectShares((current) => current.map((share) => share.project === previousName ? { ...share, project: nextName } : share));
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
    setProjectShares((current) => current.filter((share) => share.project !== project));
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
    setProjectShares(data.projectShares ?? []);
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
    if (syncingFriendIds.includes(friend.id)) return;
    setSyncingFriendIds((current) => [...current, friend.id]);
    setMeshProgress(`Syncing with ${friend.displayName}…`);
    try {
      await saveQueue;
      const result = await apiRequest<{ audioCopied: number; workspace: Awaited<ReturnType<typeof loadWorkspace>> }>(`/api/friends/${encodeURIComponent(friend.id)}/sync`, { method: "POST", body: "{}" });
      applyPeerWorkspace(result.workspace);
      setMeshProgress(`Synced with ${friend.displayName}${result.audioCopied ? ` · ${result.audioCopied} audio ${result.audioCopied === 1 ? "file" : "files"} copied` : ""}.`);
    } catch (error) {
      setMeshProgress(error instanceof Error ? error.message : `Could not sync with ${friend.displayName}.`);
      const latest = await loadWorkspace().catch(() => undefined);
      if (latest) applyPeerWorkspace(latest);
    } finally {
      setSyncingFriendIds((current) => current.filter((id) => id !== friend.id));
    }
  }

  async function syncAllFriends() {
    if (!friends.length || syncingFriendIds.length) return;
    for (const friend of friends) await syncFriend(friend);
  }

  async function disconnectFriend(friend: Friend) {
    if (!window.confirm(`Disconnect ${friend.displayName}? Their existing ratings will remain attributed to them.`)) return;
    await apiRequest(`/api/friends/${encodeURIComponent(friend.id)}`, { method: "DELETE" });
    setFriends((current) => current.filter((item) => item.id !== friend.id));
    setShares((current) => current.filter((share) => share.friendId !== friend.id));
    setProjectShares((current) => current.filter((share) => share.friendId !== friend.id));
  }

  function toggleDemoShare(demo: Demo, friendId: string) {
    if (!account || demo.ownerId !== account.id) return;
    setShares((current) => current.some((share) => share.demoUuid === demo.uuid && share.friendId === friendId)
      ? current.filter((share) => share.demoUuid !== demo.uuid || share.friendId !== friendId)
      : [...current, { demoUuid: demo.uuid, friendId, shareAudio: true }]);
  }

  function toggleProjectShare(projectName: string, friendId: string) {
    if (!account || !projects.some((item) => item.name === projectName)) return;
    setProjectShares((current) => current.some((share) => share.project === projectName && share.friendId === friendId)
      ? current.filter((share) => share.project !== projectName || share.friendId !== friendId)
      : [...current, { project: projectName, friendId, shareAudio: true }]);
  }

  function toggleDemoSelection(id: number) {
    setSelectedDemoIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function selectVisibleDemos() {
    const ids = visibleDemos.filter((demo) => demo.ownerId === account?.id).map((demo) => demo.id);
    setSelectedDemoIds((current) => {
      const next = new Set(current);
      const allSelected = ids.length > 0 && ids.every((id) => next.has(id));
      ids.forEach((id) => allSelected ? next.delete(id) : next.add(id));
      return next;
    });
  }

  function openBulkShare() {
    if (!selectedDemos.length || !friends.length) return;
    setBulkShareFriendIds(friends.filter((friend) => selectedDemos.every((demo) => shares.some((share) => share.demoUuid === demo.uuid && share.friendId === friend.id))).map((friend) => friend.id));
    setBulkShareProgress("");
    setShowBulkShare(true);
  }

  function applyBulkShare(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedDemos.length) return;
    const selectedUuids = new Set(selectedDemos.map((demo) => demo.uuid));
    const selectedFriends = new Set(bulkShareFriendIds);
    setShares((current) => {
      const next = current.filter((share) => !selectedUuids.has(share.demoUuid) || !friends.some((friend) => friend.id === share.friendId));
      selectedDemos.forEach((demo) => friends.forEach((friend) => {
        if (selectedFriends.has(friend.id)) next.push({ demoUuid: demo.uuid, friendId: friend.id, shareAudio: true });
      }));
      return next;
    });
    setBulkShareProgress(`Sharing ${selectedDemos.length} demos with ${selectedFriends.size} ${selectedFriends.size === 1 ? "friend" : "friends"}. Sync them to send the changes.`);
    setShowBulkShare(false);
  }

  function exportBackup() {
    const payload = JSON.stringify({ version: 8, exportedAt: new Date().toISOString(), demos, projects, tags, orders, media, listens, timedNotes, shares, projectShares }, null, 2);
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
      setDemos(restoredDemos); setProjects(data.projects); setTags(restoredTags); setOrders(data.orders ?? {}); setMedia(data.media ?? []); setListens(restoredListens); setTimedNotes(restoredTimedNotes); setShares(data.shares ?? []); setProjectShares(data.projectShares ?? []);
      setSelectedId(restoredDemos[0]?.id ?? 1); setProject("All demos"); setView("library");
    } catch { window.alert("That file is not a valid Demolition backup."); }
    event.target.value = "";
  }

  const currentTitle = view === "feedback" ? "Friend feedback" : view === "stats" ? "Stats overview" : view === "revisit" ? "Revisit queue" : view === "project" ? project : "Demo library";

  if (remoteToken) return <PhoneRemote token={remoteToken} />;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">✳</span><span>demolition</span><button type="button" className="mobile-menu-toggle" aria-controls="workspace-navigation" aria-expanded={mobileMenuOpen} onClick={() => setMobileMenuOpen((open) => !open)}><span aria-hidden="true">☰</span><span>Menu</span></button></div>
        <div id="workspace-navigation" className={`mobile-menu ${mobileMenuOpen ? "open" : ""}`}>
          <div className="sidebar-label">Workspace</div>
          <nav className="main-nav" aria-label="Main navigation">
            <button onClick={() => { closeMobileMenu(); selectProject("All demos"); }} className={`nav-item ${view === "library" ? "active" : ""}`}><span>▦</span> Demo library <b>{demos.length}</b></button>
            <button onClick={() => { closeMobileMenu(); setStatsFilters([]); setView("revisit"); setProject("All demos"); setFilter("All"); }} className={`nav-item ${view === "revisit" ? "active" : ""}`}><span>◌</span> Revisit queue <b className="inbox-count">{revisitDemos.length}</b></button>
            <button onClick={openFeedback} className={`nav-item ${view === "feedback" ? "active" : ""}`}><span>↯</span> Friend feedback {unreadFeedbackCount > 0 ? <b className="inbox-count">{unreadFeedbackCount}</b> : <b>{feedbackItems.length}</b>}</button>
            <button onClick={() => { closeMobileMenu(); setView("stats"); setProject("All demos"); setFilter("All"); }} className={`nav-item ${view === "stats" ? "active" : ""}`}><span>▥</span> Stats overview</button>
            <button onClick={() => { closeMobileMenu(); setShowTags(true); }} className="nav-item"><span>#</span> Manage tags <b>{tags.length}</b></button>
            <button onClick={() => { closeMobileMenu(); exportBackup(); }} className="nav-item"><span>⇩</span> Export backup</button>
            <button onClick={() => { closeMobileMenu(); importRef.current?.click(); }} className="nav-item"><span>⇧</span> Restore backup</button>
            <button onClick={() => { closeMobileMenu(); setDetectProgress(""); setShowBulkDetect(true); }} className="nav-item"><span>⌁</span> Detect BPM <b>{demos.filter((demo) => !demo.bpm).length}</b></button>
            <button onClick={() => { closeMobileMenu(); startRapidListen(); }} className="nav-item"><span>▶</span> Listen mode</button>
            <button onClick={() => { closeMobileMenu(); setMeshProgress(""); setShowAccount(true); }} className="nav-item"><span>◎</span> Friends &amp; sync <b>{friends.length}</b></button>
            <button onClick={() => { closeMobileMenu(); setStorageProgress(""); refreshStorageInfo().catch(() => undefined); setShowStorage(true); }} className="nav-item"><span>◈</span> Storage health {pendingBulkImport?.conflicts.length ? <b className="inbox-count">{pendingBulkImport.conflicts.length}</b> : null}</button>
            <input ref={importRef} className="sr-only" type="file" accept="application/json" onChange={importBackup} />
          </nav>
          <div className="sidebar-label project-label">Projects <button onClick={() => { closeMobileMenu(); setShowProject(true); }} aria-label="Add project">+</button></div>
          <div className="project-list">
            {projects.map((item) => <button key={item.name} onClick={() => { closeMobileMenu(); selectProject(item.name); }} className={`project-item ${view === "project" && project === item.name ? "selected" : ""}`}><span className={`project-dot ${item.color}`} />{item.name}<span className="count">{demos.filter((demo) => demo.project === item.name).length}</span></button>)}
            <button onClick={() => { closeMobileMenu(); selectProject("Unsorted"); }} className={`project-item ${view === "project" && project === "Unsorted" ? "selected" : ""}`}><span className="project-dot muted" />Unsorted<span className="count">{demos.filter((demo) => demo.project === "Unsorted").length}</span></button>
          </div>
        </div>
        <div className="local-badge"><span>●</span><div><strong>Local SQLite library</strong><small>Original files remain untouched</small></div></div>
        <div className="sidebar-bottom"><div className="mini-avatar">{account?.displayName.slice(0, 2).toUpperCase() || "—"}</div><div><strong>{account?.displayName || "Local owner"}</strong><span>{friends.length} connected {friends.length === 1 ? "friend" : "friends"}</span></div></div>
      </aside>

      <section className="content">
        <header className="topbar"><div className="breadcrumb"><span>Workspace</span><i>/</i><strong>{currentTitle}</strong></div><div className="top-actions"><label className="search"><span>⌕</span><input value={search} onChange={(event) => { setStatsFilters([]); setSearch(event.target.value); }} placeholder={view === "feedback" ? "Search feedback" : "Search demos"} /></label><button className="avatar" aria-label="Open account" onClick={() => setShowAccount(true)}>{account?.displayName.slice(0, 2).toUpperCase() || "—"}</button></div></header>
        <div className="page-content">
          <div className="heading-row"><div><div className="eyebrow">{todayLabel || "TODAY"}</div><h1>{currentTitle}</h1><p className="lede">{view === "feedback" ? <><strong>{feedbackItems.length}</strong> ratings and timed notes received from friends.</> : view === "stats" ? <>{statsFilters.length ? "Filtered stats for" : "A catalogue overview of"} <strong>{statsFilteredDemos.length} demos</strong>, their lengths, tempos, and keys.</> : view === "revisit" ? `${revisitDemos.length} demos are queued, oldest first.` : view === "project" ? projectTab === "moodboard" ? "Collect visual, video, and audio references for this project." : "Move demos between the candidate pool and ordered tracklist." : <>Your library contains <strong>{demos.length} demos</strong>, with <strong>{revisitDemos.length}</strong> queued for review.</>}</p></div><div className="heading-actions">{view === "feedback" && <button className="primary-button" disabled={!friends.length || syncingFriendIds.length > 0} onClick={syncAllFriends}>{syncingFriendIds.length ? "Syncing…" : "Sync friends"}</button>}{view === "stats" && <><button className="secondary-button" onClick={() => { setDetectProgress(""); setShowBulkDetect(true); }}>⌁ Detect BPM</button><button className="secondary-button" onClick={() => { setKeyDetectProgress(""); setShowKeyDetect(true); }}>♬ Analyze keys</button><button className="primary-button stats-listen-button" disabled={!statsAuditionDemos.length} onClick={() => startRapidListen(statsAuditionDemos)}>{statsAuditionDemos.length ? `▶ Listen to ${statsFilters.length ? "filtered " : ""}${statsAuditionDemos.length}` : statsFilteredDemos.length ? "No local audio" : "No matching demos"}</button></>}{view === "revisit" && <button className="secondary-button" onClick={pickForMe}>Pick one for me</button>}{view === "project" && project !== "Unsorted" && <button className="settings-button" onClick={() => setShowProjectSettings(true)} aria-label={`Manage ${project}`}>⚙ Project settings</button>}{view === "project" && project !== "Unsorted" && projectTab === "moodboard" && <button className="secondary-button" onClick={() => setShowMedia(true)}>＋ Add reference</button>}{view !== "feedback" && <><button className="secondary-button" onClick={openSingleImport}>＋ One demo</button><button className="primary-button" onClick={openBulkImport}><span>＋</span> {pendingBulkImport?.conflicts.length ? `Resolve ${pendingBulkImport.conflicts.length} conflicts` : "Bulk import"}</button></>}</div></div>
          {importNotice && <div className="import-notice" role="status"><span>✓</span><p>{importNotice}</p><button onClick={() => setImportNotice("")} aria-label="Dismiss import summary">×</button></div>}

          {statsFilters.length > 0 && view !== "stats" && <div className="stats-filter-notice" role="status"><span>FILTER</span><div className="stats-filter-copy"><p><strong>{statsFilteredDemos.length}</strong> matching demos from the statistics view.</p><div className="stats-filter-chips">{statsFilters.map((activeFilter) => <button type="button" className="stats-filter-chip" key={`${activeFilter.type}-${activeFilter.value}`} onClick={() => setStatsFilters(statsFilters.filter((filter) => filter !== activeFilter))} aria-label={`Remove ${activeFilter.label} filter`}>{activeFilter.label} ×</button>)}</div></div><button className="stats-filter-listen" disabled={!statsAuditionDemos.length} onClick={() => startRapidListen(statsAuditionDemos)}>{statsAuditionDemos.length ? `▶ Listen to ${statsAuditionDemos.length}` : statsFilteredDemos.length ? "No local audio" : "No matches"}</button><button onClick={() => setStatsFilters([])}>Clear all ×</button></div>}

          {view === "feedback" ? <section className="feedback-page" aria-label="Friend feedback">
            <div className="feedback-summary">
              <div><span className="stat-label">ALL FEEDBACK</span><strong>{feedbackItems.length}</strong></div>
              <div><span className="stat-label">RATINGS</span><strong>{feedbackItems.filter((item) => item.kind === "rating").length}</strong></div>
              <div><span className="stat-label">TIMED NOTES</span><strong>{feedbackItems.filter((item) => item.kind === "note").length}</strong></div>
              <div><span className="stat-label">LISTENERS</span><strong>{new Set(feedbackItems.map((item) => item.authorName)).size}</strong></div>
            </div>
            <div className="feedback-toolbar">
              <div className="feedback-filters" role="group" aria-label="Filter feedback">
                {(["all", "ratings", "notes"] as FeedbackFilter[]).map((item) => <button type="button" key={item} className={feedbackFilter === item ? "active" : ""} aria-pressed={feedbackFilter === item} onClick={() => setFeedbackFilter(item)}>{item === "all" ? "All" : item === "ratings" ? "Ratings" : "Timed notes"}</button>)}
              </div>
              <span>{visibleFeedback.length} shown · newest received first</span>
            </div>
            {visibleFeedback.length ? <div className="feedback-list">{visibleFeedback.map((item) => {
              const available = demos.some((demo) => demo.id === item.demoId);
              return <article className={`feedback-card feedback-${item.kind}`} key={item.id}>
                <div className="feedback-author"><span>{item.authorName.slice(0, 2).toUpperCase()}</span><div><strong>{item.authorName}</strong><small>{item.kind === "rating" ? "TRACK RATING" : "TIMED NOTE"}</small></div><time dateTime={new Date(item.receivedAt).toISOString()}>{relativeDate(item.receivedAt)}</time></div>
                <div className="feedback-content"><b className={item.verdict === "down" ? "down" : ""}>{item.kind === "rating" ? item.verdict === "up" ? "↑" : "↓" : "⌁"}</b><div><button type="button" disabled={!available} onClick={() => openFeedbackDemo(item)}>{item.demoTitle}</button>{item.kind === "note" && <small>{formatDuration(item.startSeconds || 0)}–{formatDuration(item.endSeconds || 0)}</small>}<p>{item.text}</p></div></div>
                <footer><span>{item.kind === "rating" ? item.verdict === "up" ? "Thumbs up" : "Thumbs down" : "Range note"}</span><button type="button" disabled={!available} onClick={() => openFeedbackDemo(item)}>{available ? "Open demo →" : "Demo unavailable"}</button></footer>
              </article>;
            })}</div> : <div className="feedback-empty"><span>↯</span><strong>{feedbackItems.length ? "No feedback matches this view" : "No friend feedback yet"}</strong><p>{feedbackItems.length ? "Change the filter or search text." : friends.length ? "Sync your connected friends to receive their ratings and timed notes." : "Connect a friend, share demos, then sync their responses here."}</p>{friends.length > 0 && !feedbackItems.length && <button className="primary-button" onClick={syncAllFriends}>Sync friends</button>}</div>}
          </section> : view === "stats" ? <section className="stats-page" aria-label="Demo statistics">
            <div className="stats-summary-grid">
              <article className="stats-summary-card stats-summary-primary"><span className="stat-label">CATALOGUE</span><strong>{statsFilteredDemos.length}</strong><small>{statsOverview.audioCount} with local audio{statsFilters.length ? ` · ${demos.length} total` : ""}</small></article>
              <article className="stats-summary-card"><span className="stat-label">TOTAL RUNTIME</span><strong>{formatRuntime(statsOverview.totalRuntime)}</strong><small>{statsOverview.timedCount} demos with a recorded length</small></article>
              <article className="stats-summary-card"><span className="stat-label">AVERAGE LENGTH</span><strong>{formatRuntime(statsOverview.averageRuntime)}</strong><small>{statsOverview.longest ? `Longest: ${statsOverview.longest.title}` : "No audio lengths yet"}</small></article>
              <article className="stats-summary-card"><span className="stat-label">COMMON BPM</span><strong>{statsOverview.commonBpm ? `${statsOverview.commonBpm[0]} BPM` : "—"}</strong><small>{statsOverview.commonBpm ? `${statsOverview.commonBpm[1]} ${statsOverview.commonBpm[1] === 1 ? "demo" : "demos"} · average ${statsOverview.bpmAverage}` : "No BPM values yet"}</small></article>
            </div>

            <section className="stats-audition-panel">
              <div className="stats-panel-head"><div><span className="eyebrow">LISTENING MODE</span><h2>Build an audition set</h2><p className="stats-panel-intro">Combine filters, then audition only the matching demos. For example: set BPM max to 100 and choose F maj.</p></div><span className="stats-panel-meta">{statsFilters.length ? `${statsFilteredDemos.length} current matches` : `${statsFilteredDemos.length} demos available`}</span></div>
              <div className="stats-audition-controls">
                <label>BPM minimum<input type="number" min="1" max="400" step="1" value={auditionBpmMin} onChange={(event) => setAuditionBpmMin(event.target.value)} placeholder="Any" /></label>
                <label>BPM maximum<input type="number" min="1" max="400" step="1" value={auditionBpmMax} onChange={(event) => setAuditionBpmMax(event.target.value)} placeholder="e.g. 100" /></label>
                <label>Key<select value={auditionKey} onChange={(event) => setAuditionKey(event.target.value)}><option value="">Any key</option>{statsOverview.keys.map(([key]) => <option key={`audition-${key}`} value={key}>{key}</option>)}</select></label>
                <label>Minimum length (seconds)<input type="number" min="1" step="1" value={auditionDurationMin} onChange={(event) => setAuditionDurationMin(event.target.value)} placeholder="e.g. 120" /></label>
                <label>Maximum length (seconds)<input type="number" min="1" step="1" value={auditionDurationMax} onChange={(event) => setAuditionDurationMax(event.target.value)} placeholder="Any" /></label>
                <label>Project<select value={auditionProject} onChange={(event) => setAuditionProject(event.target.value)}>{statsProjectOptions.map((name) => <option key={`audition-project-${name}`} value={name}>{name}</option>)}</select></label>
                <label>Status<select value={auditionStatus} onChange={(event) => setAuditionStatus(event.target.value as Status | "")}><option value="">Any status</option>{Object.entries(statusLabels).map(([value, label]) => <option key={`audition-status-${value}`} value={value}>{label}</option>)}</select></label>
              </div>
              <div className="stats-audition-actions"><button type="button" className="primary-button" onClick={() => applyAuditionFilters()}>Apply filters</button>{statsFilters.length > 0 && <button type="button" className="text-button" onClick={() => setStatsFilters([])}>Clear active filters</button>}</div>
              <p className="stats-note">Length filters use seconds: 120 is two minutes. Demos without a BPM, key, or measurable length are excluded when that filter is active.</p>
            </section>

            <section className="stats-comparison-panel">
              <div className="stats-panel-head"><div><span className="eyebrow">COMPARISON</span><h2>Compare projects or date periods</h2></div><select className="stats-compare-mode" value={statsComparisonMode} onChange={(event) => setStatsComparisonMode(event.target.value as StatsComparisonMode)} aria-label="Comparison mode"><option value="projects">Compare projects</option><option value="dates">Compare date periods</option></select></div>
              {statsComparisonMode === "projects" ? <div className="stats-compare-controls"><label>Project A<select value={statsProjectA} onChange={(event) => setStatsProjectA(event.target.value)}>{statsProjectOptions.map((name) => <option key={`a-${name}`}>{name}</option>)}</select></label><label>Project B<select value={statsProjectB} onChange={(event) => setStatsProjectB(event.target.value)}>{statsProjectOptions.map((name) => <option key={`b-${name}`}>{name}</option>)}</select></label><label>Created from<input type="date" value={statsSharedFrom} onChange={(event) => setStatsSharedFrom(event.target.value)} /></label><label>Created to<input type="date" value={statsSharedTo} onChange={(event) => setStatsSharedTo(event.target.value)} /></label></div> : <div className="stats-compare-controls date-comparison-controls"><label>Project scope<select value={statsDateProject} onChange={(event) => setStatsDateProject(event.target.value)}>{statsProjectOptions.map((name) => <option key={`date-${name}`}>{name}</option>)}</select></label><fieldset><legend>Period A</legend><label>From<input type="date" value={statsPeriodAFrom} onChange={(event) => setStatsPeriodAFrom(event.target.value)} /></label><label>To<input type="date" value={statsPeriodATo} onChange={(event) => setStatsPeriodATo(event.target.value)} /></label></fieldset><fieldset><legend>Period B</legend><label>From<input type="date" value={statsPeriodBFrom} onChange={(event) => setStatsPeriodBFrom(event.target.value)} /></label><label>To<input type="date" value={statsPeriodBTo} onChange={(event) => setStatsPeriodBTo(event.target.value)} /></label></fieldset></div>}
              <div className="stats-compare-results">{[statsComparison.first, statsComparison.second].map((group, index) => <article className={`stats-compare-card ${index === 0 ? "first" : "second"}`} key={`${group.label}-${index}`}><span className="eyebrow">{group.label}</span><strong>{group.count} <small>{group.count === 1 ? "demo" : "demos"}</small></strong><dl className="stats-compare-metrics"><div><dt>RUNTIME</dt><dd>{formatRuntime(group.runtime)}</dd></div><div><dt>AVERAGE</dt><dd>{formatRuntime(group.average)}</dd></div><div><dt>COMMON BPM</dt><dd>{group.commonBpm ? `${group.commonBpm[0]} BPM` : "—"}</dd></div></dl></article>)}</div>
              <p className="stats-note">{statsComparison.note}. Date comparisons use creation dates extracted from demo titles or entered manually; demos without a creation date are excluded when a date range is set.</p>
            </section>

            <section className="stats-trend-panel">
              <div className="stats-panel-head"><div><span className="eyebrow">CREATION TIMELINE</span><h2>How the catalogue has grown</h2></div><span className="stats-panel-meta">{statsOverview.datedCount} dated · {statsFilteredDemos.length - statsOverview.datedCount} undated</span></div>
              <div className="stats-trend-toolbar"><div className="stats-trend-modes"><button type="button" className={statsTrendMetric === "count" ? "active" : ""} aria-pressed={statsTrendMetric === "count"} onClick={() => setStatsTrendMetric("count")}>Demos</button><button type="button" className={statsTrendMetric === "runtime" ? "active" : ""} aria-pressed={statsTrendMetric === "runtime"} onClick={() => setStatsTrendMetric("runtime")}>Runtime</button><button type="button" className={statsTrendMetric === "bpm" ? "active" : ""} aria-pressed={statsTrendMetric === "bpm"} onClick={() => setStatsTrendMetric("bpm")}>Average BPM</button></div><small>Click a month to refine these stats</small></div>
              {statsOverview.dateTrend.length ? <div className="stats-trend-chart" aria-label={`Demo ${statsTrendMetric} over creation months`}>{statsOverview.dateTrend.map((point) => <button type="button" className={`stats-trend-column ${hasStatsFilter(statsFilters, "date", point.month) ? "selected" : ""}`} key={point.month} onClick={() => applyStatsFilter({ type: "date", value: point.month, label: `${point.label} demos` })} aria-label={`Show ${point.count} demos from ${point.label}`} aria-pressed={hasStatsFilter(statsFilters, "date", point.month)} title={`${point.label}: ${point.count} demos · ${formatRuntime(point.runtime)} · ${point.averageBpm ? `${point.averageBpm} BPM average` : "no BPM average"}`}><span className="stats-trend-bar" style={{ height: `${(statsTrendMetric === "count" ? point.count / statsOverview.dateTrendMaxCount : statsTrendMetric === "runtime" ? point.runtime / statsOverview.dateTrendMaxRuntime : point.averageBpm / statsOverview.dateTrendMaxBpm) * 100}%` }} /><strong>{statsTrendMetric === "count" ? point.count : statsTrendMetric === "runtime" ? formatRuntime(point.runtime) : point.averageBpm ? `${point.averageBpm}` : "—"}</strong><small>{point.label}</small></button>)}</div> : <div className="stats-empty"><span>⌁</span><strong>No creation dates yet</strong><small>Dates are extracted from filenames when they follow a recognizable pattern, or can be entered while editing a demo.</small></div>}
              <p className="stats-note">Bars show {statsTrendMetric === "count" ? "the number of demos" : statsTrendMetric === "runtime" ? "total recorded runtime" : "average recorded BPM"} per creation month. Demos without a creation date are not plotted.</p>
            </section>

            <div className="stats-columns">
              <section className="stats-panel">
                <div className="stats-panel-head"><div><span className="eyebrow">LENGTH PROFILE</span><h2>How long are the demos?</h2></div><span className="stats-panel-meta">{formatRuntime(statsOverview.totalRuntime)} total</span></div>
                <div className="stats-bar-list">{statsOverview.durationBuckets.map((bucket) => <button type="button" className={`stats-bar-row ${hasStatsFilter(statsFilters, "duration", bucket.value) ? "selected" : ""}`} key={bucket.label} onClick={() => applyStatsFilter({ type: "duration", value: bucket.value, label: `${bucket.label} demos (${bucket.range})` })} aria-pressed={hasStatsFilter(statsFilters, "duration", bucket.value)}><div className="stats-bar-copy"><strong>{bucket.label}</strong><small>{bucket.range}</small></div><div className="stats-bar-track"><span style={{ width: `${bucket.count / statsOverview.durationMax * 100}%` }} /></div><b>{bucket.count}</b></button>)}</div>
                <p className="stats-note">Lengths come from the stored audio metadata. {statsOverview.timedCount === 0 ? "Import an audio demo to start building this breakdown." : `${statsOverview.timedCount} of ${statsFilteredDemos.length} demos have a measurable length.`}</p>
                <div className="stats-quick-filters"><button type="button" onClick={() => applyStatsFilter({ type: "duration", value: "over2", label: "Demos over 2 minutes" })}>Filter over 2 min <span>→</span></button></div>
              </section>

              <section className="stats-panel">
                <div className="stats-panel-head"><div><span className="eyebrow">TEMPO PROFILE</span><h2>Where do the BPMs sit?</h2></div><span className="stats-panel-meta">{statsOverview.unknownBpm} unknown</span></div>
                <div className="stats-bar-list">{statsOverview.bpmBuckets.map((bucket) => <button type="button" className={`stats-bar-row ${hasStatsFilter(statsFilters, "bpm", bucket.value) ? "selected" : ""}`} key={bucket.label} onClick={() => applyStatsFilter({ type: "bpm", value: bucket.value, label: `${bucket.label} tempo (${bucket.range})` })} aria-pressed={hasStatsFilter(statsFilters, "bpm", bucket.value)}><div className="stats-bar-copy"><strong>{bucket.label}</strong><small>{bucket.range}</small></div><div className="stats-bar-track teal"><span style={{ width: `${bucket.count / statsOverview.bpmMax * 100}%` }} /></div><b>{bucket.count}</b></button>)}</div>
                <p className="stats-note">{statsOverview.commonBpm ? `Most common: ${statsOverview.commonBpm[0]} BPM across ${statsOverview.commonBpm[1]} ${statsOverview.commonBpm[1] === 1 ? "demo" : "demos"}.` : "Add or detect BPM values to see your tempo profile."}</p>
                {statsOverview.commonBpm && <div className="stats-quick-filters"><button type="button" onClick={() => applyStatsFilter({ type: "bpm-exact", value: String(statsOverview.commonBpm?.[0]), label: `Demos at exactly ${statsOverview.commonBpm?.[0]} BPM` })}>Filter exact {statsOverview.commonBpm[0]} BPM <span>→</span></button></div>}
              </section>

              <section className="stats-panel stats-panel-wide">
                <div className="stats-panel-head"><div><span className="eyebrow">KEY PROFILE</span><h2>Recorded and detected keys</h2></div><span className="stats-panel-meta">{statsOverview.keys[0] ? `Most common ${statsOverview.keys[0][0]}` : "No key data"}</span><button className="text-button" onClick={() => { setKeyDetectProgress(""); setShowKeyDetect(true); }}>Analyze audio <span>→</span></button></div>
                {statsOverview.keys.length ? <div className="stats-key-grid">{statsOverview.keys.slice(0, 12).map(([key, count]) => <button type="button" className={`stats-key-item ${hasStatsFilter(statsFilters, "key", key) ? "selected" : ""}`} key={key} onClick={() => applyStatsFilter({ type: "key", value: key, label: `${key} key` })} aria-pressed={hasStatsFilter(statsFilters, "key", key)}><div><strong>{key}</strong><small>{count} {count === 1 ? "demo" : "demos"}</small></div><div className="stats-key-track"><span style={{ width: `${count / statsOverview.keyMax * 100}%` }} /></div></button>)}</div> : <div className="stats-empty"><span>♬</span><strong>No keys recorded yet</strong><small>Enter keys while editing demos, or let Demolition estimate them from attached audio.</small></div>}
                <p className="stats-note">{statsOverview.keys.length ? `${statsOverview.unknownKeys} ${statsOverview.unknownKeys === 1 ? "demo has" : "demos have"} no key value. Estimates are local and work best on harmonic material.` : "Key detection is an estimate, not a substitute for a tuner or a musician's ear."}</p>
              </section>

              <section className="stats-panel">
                <div className="stats-panel-head"><div><span className="eyebrow">WORKFLOW</span><h2>Demo status</h2></div><span className="stats-panel-meta">{statsFilteredDemos.length} total</span></div>
                <div className="stats-bar-list compact">{statsOverview.statusBreakdown.map((item) => <button type="button" className={`stats-bar-row ${hasStatsFilter(statsFilters, "status", item.value) ? "selected" : ""}`} key={item.label} onClick={() => applyStatsFilter({ type: "status", value: item.value, label: `${item.label} demos` })} aria-pressed={hasStatsFilter(statsFilters, "status", item.value)}><div className="stats-bar-copy"><strong>{item.label}</strong></div><div className="stats-bar-track amber"><span style={{ width: `${item.count / statsOverview.statusMax * 100}%` }} /></div><b>{item.count}</b></button>)}</div>
              </section>

              <section className="stats-panel">
                <div className="stats-panel-head"><div><span className="eyebrow">PROJECTS</span><h2>Where do they live?</h2></div></div>
                {statsOverview.projectBreakdown.length ? <div className="stats-bar-list compact">{statsOverview.projectBreakdown.slice(0, 8).map(([name, count]) => <button type="button" className={`stats-bar-row ${hasStatsFilter(statsFilters, "project", name) ? "selected" : ""}`} key={name} onClick={() => applyStatsFilter({ type: "project", value: name, label: `${name} project` })} aria-pressed={hasStatsFilter(statsFilters, "project", name)}><div className="stats-bar-copy"><strong>{name}</strong></div><div className="stats-bar-track violet"><span style={{ width: `${count / statsOverview.projectMax * 100}%` }} /></div><b>{count}</b></button>)}</div> : <div className="stats-empty small"><strong>No projects yet</strong></div>}
              </section>
            </div>
          </section> : <>
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
          <div className="demo-panel" onDragOver={(event) => { if (view === "project") event.preventDefault(); }} onDrop={() => { if (view === "project") dropOnTracklist(); }}><div className="filter-row"><div className="filters">{["All", "Favourites", "Unheard", "Revisit", "Shaping", "Finished"].map((item) => <button key={item} onClick={() => { setStatsFilters([]); setFilter(item); }} className={filter === item ? "filter-active" : ""}>{item}</button>)}</div><div className="filter-tools"><select className="tag-select" value={tagFilter} onChange={(event) => { setStatsFilters([]); setTagFilter(event.target.value); }} aria-label="Filter by tag"><option>All tags</option>{tags.map((tag) => <option key={tag.name}>{tag.name}</option>)}</select>{view === "project" ? <span className="sort-button">↕ Drag to reorder</span> : <select className="sort-select" value={sortBy} onChange={(event) => setSortBy(event.target.value as typeof sortBy)} aria-label="Sort demos"><option value="score">Score · highest</option><option value="updated">Recently updated</option><option value="created-new">Creation date · newest</option><option value="created-old">Creation date · oldest</option><option value="title">Title · A–Z</option></select>}</div></div>{view !== "project" && <div className="bulk-share-toolbar"><label><input type="checkbox" checked={visibleDemos.filter((demo) => demo.ownerId === account?.id).length > 0 && visibleDemos.filter((demo) => demo.ownerId === account?.id).every((demo) => selectedDemoIds.has(demo.id))} onChange={selectVisibleDemos} aria-label="Select all visible demos" /> Select visible</label><span>{selectedDemos.length ? `${selectedDemos.length} selected` : "Select demos to share"}</span><button type="button" className="secondary-button" disabled={!selectedDemos.length || !friends.length} onClick={openBulkShare}>Share selected</button></div>}<div className="demo-table"><div className="table-head"><span>{view === "project" ? "TRACK / DEMO" : "DEMO"}</span><span>DETAILS</span><span>STATUS</span><span>UPDATED</span><span /></div>{visibleDemos.map((demo, index) => <div className="demo-row-wrap" key={demo.id}>{view !== "project" && demo.ownerId === account?.id && <label className="demo-select"><input type="checkbox" checked={selectedDemoIds.has(demo.id)} onChange={() => toggleDemoSelection(demo.id)} aria-label={`Select ${demo.title}`} /></label>}<button draggable={view === "project"} onDragStart={() => setDraggedId(demo.id)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.stopPropagation(); dropOnTracklist(demo.id); }} onClick={() => setSelectedId(demo.id)} className={`demo-row ${selectedId === demo.id ? "row-selected" : ""}`}><span className="demo-name">{view === "project" && <b className="track-number">{String(index + 1).padStart(2, "0")}</b>}<span className={`cover cover-${demo.id % 4}`}><i /></span><span><strong>{demo.title}{demo.favorite && <i className="favorite-mark" aria-label="Favourite">★</i>}</strong><small>{demo.creationDate && <b className="date-tag">{formatCreationDate(demo.creationDate)}</b>}{demo.tags.join("  ·  ")}{demo.audioName ? "  ·  audio linked" : ""}</small></span></span><span className="details">{demo.bpm ? `${demo.bpm} BPM` : "BPM —"} <i>·</i> {demo.key} <i>·</i> {demo.duration} <i>·</i> Score {statsFor(demo.id).score > 0 ? `+${statsFor(demo.id).score}` : statsFor(demo.id).score}</span><span><b className={`status ${demo.status}`}>{statusLabels[demo.status]}</b></span><span className="updated">{relativeDate(demo.updatedAt)}</span><span className="row-arrow">→</span></button></div>)}</div>{visibleDemos.length === 0 && (view === "project" ? <div className="empty-state tracklist-empty">Drag candidates here to begin the tracklist.</div> : demos.length === 0 ? <div className="empty-state library-empty"><span>✳</span><strong>Your library is empty</strong><p>Choose a folder of demo bounces to start building your archive.</p><button onClick={openBulkImport}>＋ Import your demos</button></div> : <div className="empty-state">No demos match this view.</div>)}</div>

            {view === "project" && project !== "Unsorted" && <aside className="candidate-panel" onDragOver={(event) => event.preventDefault()} onDrop={dropInCandidatePool}><div className="candidate-head"><div><span className="eyebrow">CANDIDATE POOL</span><h3>{projectCandidates.length} candidate {projectCandidates.length === 1 ? "track" : "tracks"}</h3></div><span>Drag into tracklist →</span></div><div className="candidate-list">{projectCandidates.map((demo) => <div key={demo.id} className="candidate-row" draggable onDragStart={() => setDraggedId(demo.id)}><button onClick={() => setSelectedId(demo.id)}><span className={`cover cover-${demo.id % 4}`}><i /></span><span><strong>{demo.title}</strong><small>{demo.bpm ? `${demo.bpm} BPM` : "BPM unknown"} · {statusLabels[demo.status]}</small></span></button><button className="promote-button" onClick={() => setOrders((current) => ({ ...current, [project]: [...(current[project] ?? []).filter((id) => id !== demo.id), demo.id] }))} aria-label={`Add ${demo.title} to tracklist`}>＋</button></div>)}{projectCandidates.length === 0 && <div className="candidate-empty"><span>✓</span><strong>No candidates</strong><small>Import demos here or drag a track out of the tracklist.</small></div>}</div><div className="candidate-drop">← Drop here to return a track to the pool</div></aside>}

            {selected && (view !== "project" || project === "Unsorted") && <aside className="detail-panel"><div className="detail-top"><span className="eyebrow">SELECTED DEMO</span><div className="detail-actions"><button className={`favorite-button ${selected.favorite ? "active" : ""}`} aria-pressed={selected.favorite} aria-label={selected.favorite ? `Remove ${selected.title} from favourites` : `Add ${selected.title} to favourites`} onClick={() => toggleFavorite(selected.id)}>{selected.favorite ? "★ Favourite" : "☆ Favourite"}</button><button className="more-button" onClick={openEdit}>Edit</button></div></div><div className={`focus-cover cover-${selected.id % 4}`}><span>✳</span></div><h3>{selected.title}</h3><div className="focus-meta">{selected.bpm ? `${selected.bpm} BPM` : "BPM —"} <i>·</i> {selected.key} <i>·</i> {selected.duration}</div><button className="detect-bpm" disabled={detectingId === selected.id} onClick={detectSelectedBpm}>{detectingId === selected.id ? "◌ Analyzing tempo…" : "⌁ Detect BPM again"}</button><div className="listen-summary" aria-label={"Listen score " + selectedStats.score}><span><b>{selectedStats.up}</b> ↑</span><span><b>{selectedStats.down}</b> ↓</span><strong>{selectedStats.score > 0 ? "+" + selectedStats.score : selectedStats.score}</strong><small>{selectedStats.count} {selectedStats.count === 1 ? "listen" : "listens"} · You {selectedOwnerScore > 0 ? "+" + selectedOwnerScore : selectedOwnerScore} · Friends {selectedFriendScore > 0 ? "+" + selectedFriendScore : selectedFriendScore}</small></div>{selectedScoreBreakdown}{selectedListenHistory}{selectedTimedNoteHistory}{audioUrl ? <><audio ref={detailAudioRef} className="audio-player" src={audioUrl} controls preload="metadata" onError={() => setPlaybackError("This audio copy could not be played by the browser.")} onCanPlay={() => setPlaybackError("")} onTimeUpdate={(event) => setDetailCurrentTime(event.currentTarget.currentTime)} onSeeked={(event) => setDetailCurrentTime(event.currentTarget.currentTime)}><track kind="captions" src="data:text/vtt,WEBVTT" srcLang="en" label="Instrumental audio" /></audio>{playbackError && <small className="playback-error" role="status">{playbackError}</small>}<button className="remove-copy" onClick={removeSelectedAudioCopy}>Remove local copy</button></> : <button className="audio-empty" onClick={() => attachRef.current?.click()}><span>＋</span> Attach an audio bounce</button>}<input ref={attachRef} className="sr-only" type="file" accept="audio/*,.wav,.aif,.aiff,.mp3,.m4a,.flac" onChange={attachAudio} />{selectedSharing}<div className="detail-section"><div className="detail-section-head"><span>NEXT ACTION</span><button onClick={openEdit}>edit</button></div><p className="next-action">→ {selected.nextAction || "No next action set"}</p></div><div className="detail-section"><div className="detail-section-head"><span>NOTES</span><button onClick={openEdit}>edit</button></div><p>{selected.note || "No notes yet."}</p></div><div className="detail-section"><div className="detail-section-head"><span>PROJECT</span><button onClick={openEdit}>change</button></div><div className="assigned-project"><span className="project-dot coral" />{selected.project}<span>↗</span></div></div><button className="open-demo" onClick={openEdit}>Edit demo <span>↗</span></button></aside>}
          </div></>}
          <div className="bottom-note"><span className="spark">✳</span><span><strong>{revisitDemos.length} demos in the review queue.</strong> Sorted by oldest update.</span><button onClick={() => { setStatsFilters([]); setView("revisit"); setProject("All demos"); }}>Open revisit queue →</button></div>
          </>}
        </div>
      </section>

      {rapidMode && rapidDemo && <div className="rapid-backdrop"><section className="rapid-session" aria-label="Listen mode"><header><div><span className="eyebrow">LISTEN MODE</span><strong>{rapidIndex + 1} / {rapidIds.length}</strong></div><div className="rapid-header-actions"><button className="phone-remote-button" onClick={openPhoneRemote}>▦ Phone remote</button><button onClick={() => setRapidMode(false)} aria-label="End listen mode">×</button></div></header><div className="rapid-body"><div className="rapid-main"><div className="rapid-title"><div><h2>{rapidDemo.title}</h2><p>{rapidDemo.bpm ? `${rapidDemo.bpm} BPM` : "BPM unknown"} · {rapidDemo.key} · {rapidDemo.duration}</p></div><div className="rapid-title-actions"><button className={`favorite-button ${rapidDemo.favorite ? "active" : ""}`} aria-pressed={rapidDemo.favorite} onClick={() => toggleFavorite(rapidDemo.id)}>{rapidDemo.favorite ? "★ Favourite" : "☆ Favourite"}</button><select aria-label="Assign project" value={rapidDemo.project} onChange={(event) => changeRapidProject(event.target.value)}>{projectNames.map((name) => <option key={name}>{name}</option>)}</select></div></div>{rapidQuickTags}{rapidPreloadUrl && <audio ref={rapidPreloadAudioRef} className="rapid-preload-audio" src={rapidPreloadUrl} preload="auto" aria-hidden="true"><track kind="captions" src="data:text/vtt,WEBVTT" srcLang="en" label="Preloaded demo audio" /></audio>}{audioUrl ? <audio key={rapidDemo.id} ref={rapidAudioRef} className="rapid-audio-engine" src={audioUrl} onError={() => { setRapidPlaying(false); setPlaybackError("This audio copy could not be played by the browser."); }} onCanPlay={(event) => { if (event.currentTarget.paused) playRapidAudio(event.currentTarget); }} onEnded={(event) => handleRapidEnded(event.currentTarget)} onLoadedMetadata={(event) => handleRapidLoadedMetadata(event.currentTarget)} onDurationChange={(event) => handleRapidLoadedMetadata(event.currentTarget)} onPlay={() => { setRapidPlaying(true); setPlaybackError(""); }} onPause={() => setRapidPlaying(false)} onTimeUpdate={(event) => handleRapidTimeUpdate(event.currentTarget)} preload="auto"><track kind="captions" src="data:text/vtt,WEBVTT" srcLang="en" label="Demo audio" /></audio> : <div className="rapid-no-audio">{playbackError || "No local audio copy attached"}</div>}{rapidAnnotationTransport}<div className="rapid-vote-summary"><span>{rapidStats.up} up</span><span>{rapidStats.down} down</span><strong>Score {rapidStats.score > 0 ? `+${rapidStats.score}` : rapidStats.score}</strong></div><label className="rapid-note">Note for this listen<textarea value={rapidNote} onChange={(event) => updateRapidNote(event.target.value)} rows={3} placeholder="Optional note saved with your vote" /></label></div></div><footer><div className="rapid-controls"><button className="rapid-previous" disabled={!rapidIndex} onClick={previousRapid}><span>←</span> Previous <kbd>H</kbd></button><button className="thumb-down" aria-pressed={rapidDownSelected} onClick={() => recordListen("down")}><span>↓</span> Thumbs down <kbd>J</kbd></button><button className="thumb-up" aria-pressed={rapidUpSelected} onClick={() => recordListen("up")}><span>↑</span> Thumbs up <kbd>K</kbd></button><button className="rapid-next-track" aria-label="Skip without rating" onClick={advanceRapid}>Skip <span>→</span> <kbd>L</kbd></button></div></footer></section></div>}

      {showPhoneRemote && <div className="modal-backdrop"><section className="modal phone-pair-modal" aria-label="Pair phone remote"><button type="button" className="modal-close" onClick={() => setShowPhoneRemote(false)}>×</button><div className="eyebrow">LISTEN MODE REMOTE</div><h2>Control from your phone</h2><p>Scan this code. Playback stays on this computer while the phone controls transport and scoring.</p>{remoteQrData ? <img className="remote-qr" src={remoteQrData} alt="QR code for the phone remote" /> : <div className="remote-qr-loading">Generating code…</div>}<label>Phone-accessible app URL<input value={remoteBaseUrl} onChange={(event) => setRemoteBaseUrl(event.target.value)} placeholder="https://demolition.example.com" /></label>{/^(https?:\/\/)?(localhost|127\.0\.0\.1)(:|\/|$)/i.test(remoteBaseUrl) && <div className="remote-url-warning">localhost points back to the phone. Use your Demolition domain, LAN address, or WireGuard address.</div>}{remotePairingUrl && <div className="remote-direct-link"><input readOnly value={remotePairingUrl} aria-label="Phone remote link" /><button onClick={() => navigator.clipboard.writeText(remotePairingUrl).then(() => setRemoteStatus("Remote link copied."))}>Copy</button></div>}{remoteStatus && <div className="remote-pair-status" role="status">{remoteStatus}</div>}<div className="remote-pair-actions"><button className="secondary-button" onClick={() => setShowPhoneRemote(false)}>Keep running</button><button className="remote-end-button" disabled={!remoteSession} onClick={closePhoneRemote}>End remote</button></div><small className="remote-expiry">The pairing expires after eight hours. The phone receives track metadata only; it does not stream the audio file.</small></section></div>}

      {showAccount && account && <div className="modal-backdrop"><section className="modal mesh-modal" aria-label="Friends and sync"><button type="button" className="modal-close" onClick={() => setShowAccount(false)}>×</button><div className="eyebrow">LOCAL IDENTITY</div><h2>Friends &amp; sync</h2><form className="account-form" onSubmit={saveAccount}><div className="modal-fields"><label>Display name<input name="displayName" defaultValue={account.displayName} required /></label><label>Mesh VPN URL<input name="peerUrl" type="url" defaultValue={account.peerUrl} placeholder="http://100.64.0.10:3001" required /></label></div><span className="field-hint">Use this machine&apos;s stable VPN address. Start the server with DEMOLITION_API_HOST set to 0.0.0.0 so friends can reach it.</span><button className="secondary-button" type="submit">Save identity</button></form><div className="mesh-grid"><section><div className="detail-section-head"><span>INVITE A FRIEND</span></div><p>Create a single-use code and send it through a channel you trust.</p><button className="secondary-button" onClick={createInvite}>Create invitation</button>{pairingCode && <div className="invite-code"><textarea readOnly value={pairingCode} rows={4} aria-label="Pairing invitation code" /><button onClick={() => navigator.clipboard.writeText(pairingCode).then(() => setMeshProgress("Invitation copied."))}>Copy</button></div>}</section><section><div className="detail-section-head"><span>JOIN A FRIEND</span></div><form onSubmit={pairFriend}><textarea name="code" rows={4} placeholder="Paste their invitation code" aria-label="Friend invitation code" required /><button className="secondary-button" type="submit">Pair instance</button></form></section></div><div className="friend-list"><div className="detail-section-head"><span>CONNECTED FRIENDS</span><div><small>{friends.length}</small><button type="button" disabled={!friends.length || syncingFriendIds.length > 0} onClick={syncAllFriends}>Sync all</button></div></div>{friends.map((friend) => <article key={friend.id}><span className={`peer-status ${friend.status}`} /><div><strong>{friend.displayName}</strong><small>{friend.peerUrl}</small><small>{friend.lastSyncedAt ? `Last synced ${relativeDate(friend.lastSyncedAt)}` : "Not synced yet"}</small></div><button disabled={syncingFriendIds.includes(friend.id)} onClick={() => syncFriend(friend)}>{syncingFriendIds.includes(friend.id) ? "Syncing…" : "Sync now"}</button><button className="disconnect-peer" disabled={syncingFriendIds.includes(friend.id)} onClick={() => disconnectFriend(friend)} aria-label={`Disconnect ${friend.displayName}`}>×</button></article>)}{friends.length === 0 && <div className="friend-empty">No friends connected.</div>}</div>{meshProgress && <div className="mesh-progress" role="status">{meshProgress}</div>}<div className="mesh-security">Peer traffic stays on the VPN. Demolition also requires a separate pairing token and verifies signed ratings and timed notes.</div></section></div>}

      {showStorage && <div className="modal-backdrop"><section className="modal storage-modal" aria-label="Storage health"><button type="button" className="modal-close" onClick={() => setShowStorage(false)}>×</button><div className="eyebrow">STORAGE HEALTH</div><h2>Storage status</h2><p>Metadata is stored in SQLite. Audio and moodboard files are copied into Demolition’s local data folder.</p><div className="storage-meter"><div><strong>{formatBytes(storageInfo.usage)}</strong><span>used · {formatBytes(Math.max(0, storageInfo.quota - storageInfo.usage))} free</span></div><b>{Math.round(storagePercent)}%</b><div className="storage-bar"><span style={{ width: `${storagePercent}%` }} /></div></div><div className="health-grid"><div className="health-good"><span>✓</span><strong>Local persistent storage</strong><small>The database and managed copies remain on this machine.</small><button onClick={requestPersistentStorage}>Refresh status</button></div><div className="health-good"><span>♢</span><strong>{demos.filter((demo) => demo.checksum).length} checksummed copies</strong><small>SHA-256 fingerprints detect duplicates and unexpected byte changes.</small><button onClick={verifyAudioCopies}>Verify all copies</button></div>{pendingBulkImport?.conflicts.length ? <div className="health-warn conflict-health"><span>!</span><strong>{pendingBulkImport.conflicts.length} filename {pendingBulkImport.conflicts.length === 1 ? "conflict" : "conflicts"} unresolved</strong><small>The import is paused. Audition each version when you are ready.</small><button onClick={() => { setShowStorage(false); setShowConflictReview(true); }}>Review conflicts</button></div> : null}</div>{storageProgress && <div className="storage-result" role="status">{storageProgress.startsWith("Verifying") ? <i /> : <span>✓</span>}<p>{storageProgress}</p></div>}<div className="backup-clarity"><strong>Metadata backup ≠ audio backup</strong><p>Export Backup preserves your catalogue, projects, notes, and checksums. Your original music files remain the authoritative audio backup.</p></div><button className="primary-button modal-submit" onClick={() => setShowStorage(false)}>Done</button></section></div>}

      {showBulkDetect && <div className="modal-backdrop"><form className="modal bpm-bulk-modal" onSubmit={bulkDetectBpm}><button type="button" className="modal-close" disabled={detectProgress.startsWith("Analyzing")} onClick={() => setShowBulkDetect(false)}>×</button><div className="eyebrow">BULK BPM DETECTION</div><h2>Detect BPM</h2><p>Demolition reads each attached audio file locally and estimates its tempo. Manual BPM values are preserved by default.</p><fieldset className="choice-group"><legend>Which demos?</legend><label aria-label="Analyze demos with missing BPM only"><input type="radio" name="mode" value="missing" defaultChecked /><span><strong>Missing BPM only</strong><small>{demos.filter((demo) => !demo.bpm).length} demos currently need analysis</small></span></label><label aria-label="Re-analyze all demo BPM values"><input type="radio" name="mode" value="all" /><span><strong>Re-analyze all</strong><small>Overwrites existing BPM values in the chosen scope</small></span></label></fieldset><fieldset className="choice-group"><legend>Scope</legend><label aria-label="Analyze the entire library"><input type="radio" name="scope" value="library" defaultChecked /><span><strong>Entire library</strong><small>{demos.length} demos</small></span></label>{view === "project" && project !== "Unsorted" && <label aria-label={`Analyze ${project} only`}><input type="radio" name="scope" value="project" /><span><strong>{project}</strong><small>{demos.filter((demo) => demo.project === project).length} demos in this project</small></span></label>}</fieldset>{detectProgress && <div className={`bulk-progress ${detectProgress.startsWith("No ") ? "bulk-error" : ""}`}><span /><p>{detectProgress}</p></div>}<button className="primary-button modal-submit" disabled={detectProgress.startsWith("Analyzing")} type="submit">{detectProgress.startsWith("Analyzing") ? "Analyzing catalogue…" : "Start BPM detection"} <span>→</span></button><small className="bulk-privacy">Tracks without attached audio are skipped. BPM remains manually editable.</small></form></div>}

      {showKeyDetect && <div className="modal-backdrop"><form className="modal key-detect-modal" onSubmit={bulkDetectKeys}><button type="button" className="modal-close" disabled={keyDetectProgress.startsWith("Analyzing")} onClick={() => setShowKeyDetect(false)}>×</button><div className="eyebrow">KEY DETECTION</div><h2>Estimate musical keys</h2><p>Demolition analyzes attached audio locally using its harmonic spectrum. Results are useful for sorting a library, but ambiguous mixes may need a human check.</p><fieldset className="choice-group"><legend>Which demos?</legend><label aria-label="Analyze demos with missing keys only"><input type="radio" name="mode" value="missing" defaultChecked /><span><strong>Missing keys only</strong><small>{demos.filter((demo) => demo.audioName && !knownMusicalKey(demo.key)).length} attached demos need an estimate</small></span></label><label aria-label="Re-analyze all attached demo keys"><input type="radio" name="mode" value="all" /><span><strong>Re-analyze all attached audio</strong><small>Overwrites existing key values with local estimates</small></span></label></fieldset><fieldset className="choice-group"><legend>Scope</legend><label aria-label="Analyze the entire library"><input type="radio" name="scope" value="library" defaultChecked /><span><strong>Entire library</strong><small>{demos.filter((demo) => demo.audioName).length} demos with local audio</small></span></label>{view === "project" && project !== "Unsorted" && <label aria-label={`Analyze ${project} only`}><input type="radio" name="scope" value="project" /><span><strong>{project}</strong><small>{demos.filter((demo) => demo.project === project && demo.audioName).length} attached demos</small></span></label>}</fieldset>{keyDetectProgress && <div className={`bulk-progress ${keyDetectProgress.startsWith("No ") ? "bulk-error" : ""}`}><span /><p>{keyDetectProgress}</p></div>}<button className="primary-button modal-submit" disabled={keyDetectProgress.startsWith("Analyzing")} type="submit">{keyDetectProgress.startsWith("Analyzing") ? "Analyzing harmonic content…" : "Estimate keys"} <span>→</span></button><small className="bulk-privacy">Audio stays on this device. Key detection is experimental and may be uncertain on drums or atonal material.</small></form></div>}

      {pendingBulkImport && showConflictReview && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) deferFilenameConflicts(); }}>
        <section className="modal filename-conflict-modal" aria-label="Filename conflict review">
          <button type="button" className="modal-close" disabled={finalizingConflicts} onClick={deferFilenameConflicts}>×</button>
          <div className="eyebrow">FILENAME CONFLICT</div>
          <h2>{finalizingConflicts ? "Applying your choices" : "Audition both versions"}</h2>
          {activeFilenameConflict && (conflictExistingDemo || conflictExistingIncoming) && !finalizingConflicts ? <>
            <p><strong>{activeFilenameConflict.incoming.file.name}</strong> has the same filename as {conflictExistingDemo ? "a demo already in the library" : "another file in this import"}, but the audio contents differ.</p>
            <div className="conflict-counter">{pendingBulkImport.conflicts.length} {pendingBulkImport.conflicts.length === 1 ? "conflict" : "conflicts"} remaining</div>
            <div className="conflict-audition-grid">
              <section>
                <span>{conflictExistingDemo ? "EXISTING DEMO" : "EARLIER FILE"}</span>
                <h3>{conflictExistingDemo?.title || conflictExistingIncoming?.file.name.replace(/\.[^.]+$/, "")}</h3>
                <small>{conflictExistingDemo ? `${conflictExistingDemo.duration} · ${formatBytes(conflictExistingDemo.fileSize || 0)} · added ${new Date(conflictExistingDemo.updatedAt).toLocaleDateString("en-AU")}` : `${formatBytes(conflictExistingIncoming?.file.size || 0)} · selected earlier in this import`}</small>
                {conflictExistingUrl ? <audio src={conflictExistingUrl} controls preload="metadata"><track kind="captions" src="data:text/vtt,WEBVTT" srcLang="en" label="Existing version audio" /></audio> : <div className="conflict-audio-missing">Existing managed copy unavailable</div>}
                <button className="conflict-choice existing" onClick={() => resolveFilenameConflict("existing")}>Keep this version</button>
              </section>
              <section>
                <span>INCOMING FILE</span>
                <h3>{activeFilenameConflict.incoming.file.name.replace(/\.[^.]+$/, "")}</h3>
                <small>{formatBytes(activeFilenameConflict.incoming.file.size)} · selected from this import</small>
                {conflictIncomingUrl && <audio src={conflictIncomingUrl} controls preload="metadata"><track kind="captions" src="data:text/vtt,WEBVTT" srcLang="en" label="Incoming demo audio" /></audio>}
                <button className="conflict-choice incoming" onClick={() => resolveFilenameConflict("incoming")}>Use incoming</button>
              </section>
            </div>
            <button className="keep-both-button" onClick={() => resolveFilenameConflict("both")}>Keep both as separate demos</button>
            <small className="conflict-safety">{conflictExistingDemo ? "Using the incoming version replaces only Demolition’s managed copy. Project assignment, tags, votes, and notes stay attached to the existing demo. " : "Only the version you choose will be copied unless you keep both. "}Source files remain untouched. Close this window to continue later from Storage health.</small>
          </> : <div className="conflict-finalizing"><i /><p>{conflictProgress || "Preparing files…"}</p></div>}
        </section>
      </div>}

      {showBulk && <div className="modal-backdrop"><form className="modal bulk-modal" onSubmit={bulkImport}><button type="button" className="modal-close" disabled={/^(Checking|Analyzing)/.test(bulkProgress)} onClick={() => setShowBulk(false)}>×</button><div className="eyebrow">BULK IMPORT</div><h2>Import audio files</h2><p>Select a folder or choose several audio files. Every imported demo can receive the same batch tags.</p><div className="source-safety"><span>✓</span><div><strong>Your source files are read-only</strong><small>Demolition creates app-managed local copies. It cannot rename, overwrite, or delete anything in the selected folder.</small></div></div><div className="bulk-choices"><label className="file-drop bulk-choice"><span className="bulk-icon">▤</span><strong>Choose a folder</strong><small>Audio from all subfolders · other files ignored</small><input name="folder" type="file" accept="audio/*,.wav,.aif,.aiff,.mp3,.m4a,.flac,.ogg,.opus,.aac" multiple webkitdirectory="" /></label><label className="file-drop bulk-choice"><span className="bulk-icon">♪</span><strong>Choose audio files</strong><small>Select multiple files</small><input name="files" type="file" accept="audio/*,.wav,.aif,.aiff,.mp3,.m4a,.flac,.ogg,.opus,.aac" multiple /></label></div><label>Destination<select name="project" defaultValue={project !== "All demos" && project !== "Unsorted" ? project : projects[0]?.name ?? "Unsorted"}>{projectNames.map((name) => <option key={name}>{name}</option>)}</select></label><label>Batch tags<input name="tags" list="known-tags" placeholder="e.g. April exports, laptop sessions" /><span className="field-hint">Comma separated · applied to every file in this import</span></label>{bulkProgress && <div className={`bulk-progress ${bulkProgress.startsWith("No ") || bulkProgress.startsWith("Not ") || bulkProgress.startsWith("Nothing ") || bulkProgress.startsWith("Import stopped") ? "bulk-error" : ""}`}><span /><p>{bulkProgress}</p></div>}<button className="primary-button modal-submit" disabled={/^(Checking|Analyzing)/.test(bulkProgress)} type="submit">{/^(Checking|Analyzing)/.test(bulkProgress) ? "Checking and analyzing…" : "Import safe copies"} <span>→</span></button><small className="bulk-privacy">Only Demolition&apos;s managed copies can be removed from this app.</small></form></div>}

      {showBulkShare && <div className="modal-backdrop"><form className="modal bulk-share-modal" onSubmit={applyBulkShare}><button type="button" className="modal-close" onClick={() => setShowBulkShare(false)}>×</button><div className="eyebrow">SHARE DEMOS</div><h2>{selectedDemos.length} selected</h2><p>Choose which friends should receive these demos. Clearing a friend revokes their access; the change takes effect when they sync.</p><div className="bulk-share-actions"><button type="button" className="text-button" onClick={() => setBulkShareFriendIds(friends.map((friend) => friend.id))}>Select all</button><button type="button" className="text-button" onClick={() => setBulkShareFriendIds([])}>Clear all</button></div><div className="bulk-share-friends">{friends.map((friend) => { const sharedCount = selectedDemos.filter((demo) => shares.some((share) => share.demoUuid === demo.uuid && share.friendId === friend.id)).length; return <label key={friend.id} aria-label={`Share selected demos with ${friend.displayName}`}><input type="checkbox" checked={bulkShareFriendIds.includes(friend.id)} onChange={() => setBulkShareFriendIds((current) => current.includes(friend.id) ? current.filter((id) => id !== friend.id) : [...current, friend.id])} /><span><strong>{friend.displayName}</strong><small>{sharedCount === selectedDemos.length ? "Shared with all selected" : sharedCount ? `${sharedCount} of ${selectedDemos.length} already shared` : "Not shared yet"}</small></span></label>; })}{friends.length === 0 && <small>No connected friends.</small>}</div>{bulkShareProgress && <div className="mesh-progress">{bulkShareProgress}</div>}<button className="primary-button modal-submit" type="submit">Apply sharing <span>→</span></button></form></div>}

      {showAdd && <div className="modal-backdrop"><form className="modal" onSubmit={addDemo}><button type="button" className="modal-close" onClick={() => setShowAdd(false)}>×</button><div className="eyebrow">IMPORT DEMO</div><h2>Import one demo</h2><p>Choose an audio file. Demolition creates a managed local copy, detects its BPM, and leaves the original untouched.</p><label className="file-drop">Audio file<input name="audio" type="file" accept="audio/*,.wav,.aif,.aiff,.mp3,.m4a,.flac" /><span>Read-only source · managed local copy</span></label><label>Demo title<input name="title" placeholder="Uses the filename if left blank" /></label><div className="modal-fields"><label>BPM<input name="bpm" type="number" placeholder="Auto detect" /></label><label>Key<input name="key" placeholder="e.g. C maj · optional" /></label></div><label>Project<select name="project" defaultValue={project !== "All demos" ? project : "Unsorted"}>{projectNames.map((name) => <option key={name}>{name}</option>)}</select></label><label>Tags<input name="tags" list="known-tags" placeholder="e.g. April exports, laptop sessions" /><span className="field-hint">Comma separated</span></label><button className="primary-button modal-submit" type="submit">Import safe copy <span>→</span></button></form></div>}

      {showEdit && selected && <div className="modal-backdrop"><form className="modal edit-modal" onSubmit={editDemo}><button type="button" className="modal-close" onClick={() => setShowEdit(false)}>×</button><div className="eyebrow">EDIT DEMO</div><h2>{selected.title}</h2><div className="modal-fields"><label>Title<input name="title" defaultValue={selected.title} required /></label><label>Status<select name="status" defaultValue={selected.status}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>BPM<input name="bpm" type="number" defaultValue={selected.bpm} /></label><label>Key<input name="key" defaultValue={selected.key} /></label><label>Project<select name="project" defaultValue={selected.project}>{projectNames.map((name) => <option key={name}>{name}</option>)}</select></label></div><label>Creation date<input name="creationDate" type="date" defaultValue={selected.creationDate} /><span className="field-hint">Extracted from the title when possible; editable anytime.</span></label><label>Tags<input value={editTagsDraft} onChange={(event) => setEditTagsDraft(event.target.value)} placeholder="Type tags separated by commas" /></label>{tags.length > 0 && <div className="tag-picker" aria-label="Available tags">{tags.map((tag) => <button key={tag.name} type="button" className={parseTags(editTagsDraft).some((item) => item.toLocaleLowerCase() === tag.name.toLocaleLowerCase()) ? "selected" : ""} onClick={() => toggleEditTag(tag.name)}>#{tag.name}</button>)}</div>}<label>Next action<input name="nextAction" defaultValue={selected.nextAction} placeholder="One concrete thing to try" /></label><label>Listening notes<textarea name="note" defaultValue={selected.note} rows={4} /></label><button className="primary-button modal-submit" type="submit">Save changes <span>→</span></button></form></div>}

      {showTags && <div className="modal-backdrop"><section className="modal tags-modal" aria-label="Manage tags"><button type="button" className="modal-close" onClick={() => setShowTags(false)}>×</button><div className="eyebrow">TAGS</div><h2>Manage tags</h2><p>Create reusable tags for demo batches, sessions, locations, or any other grouping.</p><form className="tag-create" onSubmit={addCustomTag}><input name="name" placeholder="Tag name" aria-label="New tag name" required /><button className="primary-button" type="submit">Add tag</button></form><div className="tag-manager-list">{tags.map((tag) => { const count = demos.filter((demo) => demo.tags.some((item) => item.toLocaleLowerCase() === tag.name.toLocaleLowerCase())).length; return <div key={tag.name}><button className="tag-filter-link" onClick={() => { setTagFilter(tag.name); setShowTags(false); setProject("All demos"); setView("library"); }}>#{tag.name}<span>{count} {count === 1 ? "demo" : "demos"}</span></button><button className="tag-delete" onClick={() => removeCustomTag(tag.name)} aria-label={`Delete ${tag.name}`}>×</button></div>; })}{tags.length === 0 && <div className="tag-manager-empty">No tags created.</div>}</div></section></div>}

      <datalist id="known-tags">{tags.map((tag) => <option key={tag.name} value={tag.name} />)}</datalist>

      {showMedia && <div className="modal-backdrop"><form className="modal media-modal" onSubmit={addMedia}><button type="button" className="modal-close" onClick={() => setShowMedia(false)}>×</button><div className="eyebrow">ADD TO {project.toUpperCase()}</div><h2>Add a reference</h2><p>Add a local image, video, or audio file, or save a web link. Files are copied into Demolition’s local data folder.</p><label className="file-drop">Local media<input name="file" type="file" accept="image/*,video/*,audio/*,.wav,.aif,.aiff,.mp3,.m4a,.flac" /><span>Image, video, or audio reference</span></label><div className="modal-divider"><span>or add a link</span></div><div className="modal-fields"><label>Web URL<input name="url" type="url" placeholder="https://…" /></label><label>Link type<select name="kind" defaultValue="link"><option value="link">Website / song link</option><option value="image">Direct image URL</option><option value="video">Direct video URL</option><option value="audio">Direct audio URL</option></select></label></div><label>Title<input name="title" placeholder="Uses the filename if left blank" /></label><label>Notes<textarea name="note" rows={3} placeholder="Add context for this reference" /></label><button className="primary-button modal-submit" type="submit">Add to moodboard <span>→</span></button></form></div>}

      {showProjectSettings && currentProject && <div className="modal-backdrop"><form className="modal project-settings-modal" onSubmit={updateProject}><button type="button" className="modal-close" onClick={() => setShowProjectSettings(false)}>×</button><div className="eyebrow">PROJECT SETTINGS</div><h2>Edit project</h2><p>Changes apply to this project’s demos, candidate pool, tracklist, moodboard, and sharing rules.</p><div className="modal-fields"><label>Project name<input name="name" defaultValue={currentProject.name} required /></label><label>Colour<select name="color" defaultValue={currentProject.color}><option value="coral">Signal coral</option><option value="yellow">Warm yellow</option><option value="blue">Night blue</option><option value="violet">Soft violet</option></select></label></div><label>Aesthetic notes<textarea name="mood" defaultValue={currentProject.mood} rows={3} placeholder="Describe the intended visual and sonic direction" /></label><section className="project-sharing"><div className="detail-section-head"><span>SHARE PROJECT</span><small>{demos.filter((demo) => demo.project === currentProject.name).length} demos</small></div><p>Friends receive every current and future demo assigned to this project, including managed audio copies.</p><div className="share-friends">{friends.map((friend) => { const active = projectShares.some((share) => share.project === currentProject.name && share.friendId === friend.id); return <button type="button" key={friend.id} className={active ? "shared" : ""} aria-pressed={active} onClick={() => toggleProjectShare(currentProject.name, friend.id)}><span>{active ? "✓" : "+"}</span>{friend.displayName}</button>; })}{friends.length === 0 && <small>Connect a friend before sharing this project.</small>}</div></section><button className="primary-button modal-submit" type="submit">Save project <span>→</span></button><div className="danger-zone"><div><strong>Delete this project</strong><small>Demos move to Unsorted. Moodboard media is removed.</small></div><button type="button" onClick={deleteProject}>Delete project</button></div></form></div>}

      {showProject && <div className="modal-backdrop"><form className="modal project-modal" onSubmit={addProject}><button type="button" className="modal-close" onClick={() => setShowProject(false)}>×</button><div className="eyebrow">NEW PROJECT</div><h2>Create project</h2><p>Group demos, arrange a tracklist, and collect references.</p><div className="modal-fields"><label>Project name<input name="name" placeholder="e.g. Weather Systems" required /></label><label>Colour<select name="color" defaultValue="blue"><option value="coral">Signal coral</option><option value="yellow">Warm yellow</option><option value="blue">Night blue</option><option value="violet">Soft violet</option></select></label></div><label>Aesthetic notes<textarea name="mood" rows={3} placeholder="Describe the intended visual and sonic direction" /></label><button className="primary-button modal-submit" type="submit">Create project <span>→</span></button></form></div>}
    </main>
  );
}
