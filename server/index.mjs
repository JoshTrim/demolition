import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, statfs, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  acceptPairing, audioDirectory, authenticatePeer, buildSyncPackage, canFriendAccessAudio, closeRemoteSession,
  createPairingInvite, createRemoteSession, databasePath, dataDirectory, decodePairingInvite, demoByUuid, friendWithSecrets,
  getAccount, getRemoteSession, getStoredFile, markFeedbackSeen, markFriendSyncError, markPeerAudioStored, mediaDirectory,
  mergeSyncPackage, readWorkspace, removeFriend, removeStoredFile, saveStoredFile,
  sendRemoteCommand, storedFileBytes, updateAccount, updateRemoteSessionState, upsertFriend, writeWorkspace,
} from "./database.mjs";

const port = Number(process.env.DEMOLITION_API_PORT || 3001);
const host = process.env.DEMOLITION_API_HOST || "127.0.0.1";
const proxyToken = process.env.DEMOLITION_PROXY_TOKEN || "";
const allowLanOwnerApi = process.env.DEMOLITION_ALLOW_LAN === "true";

function corsHeaders(req) {
  const origin = req.headers.origin;
  const allowed = origin && /^http:\/\/(localhost|127\.0\.0\.1|\[[a-f0-9:]+\]|(?:\d{1,3}\.){3}\d{1,3}|[a-z0-9-]+\.local)(:\d+)?$/i.test(origin)
    ? origin : "http://localhost:3000";
  return {
    "access-control-allow-origin": allowed,
    "access-control-allow-methods": "GET, HEAD, PUT, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, x-file-name",
    "cache-control": "no-store",
  };
}

function sendJson(req, res, statusCode, value) {
  res.writeHead(statusCode, { ...corsHeaders(req), "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 10 * 1024 * 1024) throw new Error("Request is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function routeFile(url) {
  const match = url.pathname.match(/^\/api\/(audio|media)\/(\d+)$/);
  return match ? { type: match[1], id: Number(match[2]) } : undefined;
}

function bearerToken(req) {
  const value = String(req.headers.authorization || "");
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function requirePeer(req) {
  const peer = authenticatePeer(bearerToken(req));
  if (!peer) throw Object.assign(new Error("Peer authentication failed"), { statusCode: 401 });
  return peer;
}

function isLocalRequest(req) {
  const address = req.socket.remoteAddress || "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isPrivateLanAddress(address) {
  const normalized = address.replace(/^::ffff:/i, "");
  if (/^(?:fc|fd|fe80:)/i.test(normalized)) return true;
  const octets = normalized.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  return octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168);
}

function isOwnerApiRequest(req) {
  return isLocalRequest(req) || (allowLanOwnerApi && isPrivateLanAddress(req.socket.remoteAddress || "")) || isTrustedProxyRequest(req);
}

function isTrustedProxyRequest(req) {
  if (!proxyToken) return false;
  const supplied = Buffer.from(String(req.headers["x-demolition-proxy-token"] || ""));
  const expected = Buffer.from(proxyToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function safeFileName(value) {
  try { return path.basename(decodeURIComponent(value || "file")); }
  catch { return "file"; }
}

async function uploadFile(req, res, type, id) {
  const directory = type === "audio" ? audioDirectory : mediaDirectory;
  await mkdir(directory, { recursive: true });
  const originalName = safeFileName(req.headers["x-file-name"]);
  const extension = path.extname(originalName).slice(0, 12).replace(/[^.a-zA-Z0-9]/g, "");
  const storageName = `${id}${extension}`;
  const destination = path.join(directory, storageName);
  const temporary = path.join(directory, `.${id}-${Date.now()}.upload`);
  try {
    await pipeline(req, createWriteStream(temporary, { flags: "wx" }));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  const previous = getStoredFile(type, id);
  if (previous && previous.storage_name !== storageName) await unlink(path.join(directory, previous.storage_name)).catch(() => undefined);
  await rename(temporary, destination);
  const details = await stat(destination);
  saveStoredFile(type, id, storageName, originalName, req.headers["content-type"] || "application/octet-stream", details.size);
  sendJson(req, res, 201, { ok: true, size: details.size });
}

function playbackMimeType(record) {
  const mimeType = String(record.mime_type || "application/octet-stream").toLowerCase();
  if (mimeType === "audio/x-wav" || mimeType === "audio/wave" || mimeType === "audio/vnd.wave") return "audio/wav";
  if (mimeType === "audio/x-aiff") return "audio/aiff";
  return mimeType;
}

function aiffSampleRate(source, offset) {
  const sign = source[offset] & 0x80 ? -1 : 1;
  const exponent = ((source[offset] & 0x7f) << 8) | source[offset + 1];
  let mantissa = 0n;
  for (let index = 0; index < 8; index++) mantissa = (mantissa << 8n) | BigInt(source[offset + 2 + index]);
  if (!exponent || !mantissa) return 0;
  return sign * Number(mantissa) / 2 ** 63 * 2 ** (exponent - 16383);
}

function aiffToWav(source) {
  if (source.toString("ascii", 0, 4) !== "FORM") throw new Error("The AIFF file has no FORM header");
  const formType = source.toString("ascii", 8, 12);
  if (formType !== "AIFF" && formType !== "AIFC") throw new Error("Unsupported IFF audio format");
  let channels = 0;
  let sampleFrames = 0;
  let sampleBits = 0;
  let sampleRate = 0;
  let compression = "NONE";
  let audioStart = -1;
  let audioEnd = -1;
  for (let offset = 12; offset + 8 <= source.length;) {
    const chunkType = source.toString("ascii", offset, offset + 4);
    const chunkSize = source.readUInt32BE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = Math.min(source.length, chunkStart + chunkSize);
    if (chunkType === "COMM" && chunkEnd - chunkStart >= 18) {
      channels = source.readUInt16BE(chunkStart);
      sampleFrames = source.readUInt32BE(chunkStart + 2);
      sampleBits = source.readUInt16BE(chunkStart + 6);
      sampleRate = aiffSampleRate(source, chunkStart + 8);
      if (formType === "AIFC" && chunkEnd - chunkStart >= 22) compression = source.toString("ascii", chunkStart + 18, chunkStart + 22);
    }
    if (chunkType === "SSND" && chunkEnd - chunkStart >= 8) {
      const dataOffset = source.readUInt32BE(chunkStart);
      audioStart = chunkStart + 8 + dataOffset;
      audioEnd = chunkEnd;
    }
    offset = chunkStart + chunkSize + (chunkSize & 1);
  }
  if (!channels || !sampleFrames || !Number.isFinite(sampleRate) || sampleRate <= 0 || ![8, 16, 24, 32].includes(sampleBits) || audioStart < 0 || audioStart >= audioEnd) {
    throw new Error("The AIFF file is missing supported PCM audio data");
  }
  if (compression !== "NONE" && compression !== "sowt") throw new Error(`Unsupported AIFF compression: ${compression}`);
  const bytesPerSample = sampleBits / 8;
  const sourceAudio = source.subarray(audioStart, audioEnd);
  const sampleBytes = Math.min(sourceAudio.length, sampleFrames * channels * bytesPerSample);
  const output = Buffer.alloc(44 + sampleBytes);
  output.write("RIFF", 0, "ascii");
  output.writeUInt32LE(output.length - 8, 4);
  output.write("WAVE", 8, "ascii");
  output.write("fmt ", 12, "ascii");
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(channels, 22);
  output.writeUInt32LE(Math.round(sampleRate), 24);
  output.writeUInt32LE(Math.round(sampleRate) * channels * bytesPerSample, 28);
  output.writeUInt16LE(channels * bytesPerSample, 32);
  output.writeUInt16LE(sampleBits, 34);
  output.write("data", 36, "ascii");
  output.writeUInt32LE(sampleBytes, 40);
  if (compression === "sowt" || bytesPerSample === 1) {
    sourceAudio.copy(output, 44, 0, sampleBytes);
    if (bytesPerSample === 1) for (let index = 0; index < sampleBytes; index++) output[44 + index] ^= 0x80;
  } else {
    for (let index = 0; index < sampleBytes; index += bytesPerSample) {
      for (let byte = 0; byte < bytesPerSample; byte++) output[44 + index + byte] = sourceAudio[index + bytesPerSample - 1 - byte];
    }
  }
  return output;
}

const playbackConversions = new Map();
async function playableFile(record, directory) {
  const sourcePath = path.join(directory, record.storage_name);
  const mimeType = String(record.mime_type || "").toLowerCase();
  const isAiff = /\.aiff?$/i.test(record.original_name || record.storage_name) || mimeType === "audio/x-aiff" || mimeType === "audio/aiff";
  if (!isAiff) return { filePath: sourcePath, size: Number(record.size_bytes), mimeType: playbackMimeType(record) };
  const derivativePath = path.join(directory, `.${record.entity_id}-${record.updated_at}.playback.wav`);
  const existing = playbackConversions.get(derivativePath);
  if (existing) return existing;
  const conversion = (async () => {
    if (!existsSync(derivativePath)) {
      const wav = aiffToWav(await readFile(sourcePath));
      const temporary = `${derivativePath}.${process.pid}-${Date.now()}.tmp`;
      await writeFile(temporary, wav, { flag: "wx" });
      await rename(temporary, derivativePath);
    }
    const details = await stat(derivativePath);
    return { filePath: derivativePath, size: details.size, mimeType: "audio/wav" };
  })();
  playbackConversions.set(derivativePath, conversion);
  try {
    return await conversion;
  } finally {
    if (playbackConversions.get(derivativePath) === conversion) playbackConversions.delete(derivativePath);
  }
}

async function serveFile(req, res, type, id, extraHeaders = {}) {
  const record = getStoredFile(type, id);
  const directory = type === "audio" ? audioDirectory : mediaDirectory;
  if (!record) return sendJson(req, res, 404, { error: "File not found" });
  const sourcePath = path.join(directory, record.storage_name);
  if (!existsSync(sourcePath)) return sendJson(req, res, 404, { error: "File not found" });
  const playable = await playableFile(record, directory);
  const filePath = playable.filePath;
  const totalBytes = Math.max(0, Number(playable.size));
  const range = String(req.headers.range || "");
  let start = 0;
  let end = Math.max(0, totalBytes - 1);
  let statusCode = 200;
  if (range.startsWith("bytes=") && totalBytes > 0) {
    const [requested] = range.slice(6).split(",");
    const [rawStart, rawEnd] = requested.split("-").map((value) => value.trim());
    if (rawStart === "") {
      const suffixLength = Number(rawEnd);
      if (!Number.isFinite(suffixLength) || suffixLength <= 0) return sendJson(req, res, 416, { error: "Invalid byte range" });
      start = Math.max(0, totalBytes - suffixLength);
    } else {
      start = Number(rawStart);
      if (!Number.isInteger(start) || start < 0 || start >= totalBytes) {
        res.writeHead(416, { ...corsHeaders(req), "content-range": `bytes */${totalBytes}` });
        return res.end();
      }
      end = rawEnd === "" ? end : Math.min(totalBytes - 1, Number(rawEnd));
      if (!Number.isInteger(end) || end < start) {
        res.writeHead(416, { ...corsHeaders(req), "content-range": `bytes */${totalBytes}` });
        return res.end();
      }
    }
    statusCode = 206;
  }
  const headers = {
    ...corsHeaders(req), ...extraHeaders, "accept-ranges": "bytes", "content-type": playable.mimeType,
    "content-length": String(end - start + 1), "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(record.original_name)}`,
    "x-file-name": encodeURIComponent(record.original_name),
  };
  if (statusCode === 206) headers["content-range"] = `bytes ${start}-${end}/${totalBytes}`;
  res.writeHead(statusCode, headers);
  if (req.method === "HEAD") return res.end();
  createReadStream(filePath, { start, end }).on("error", () => res.destroy()).pipe(res);
}

async function deleteFile(req, res, type, id) {
  const record = getStoredFile(type, id);
  const directory = type === "audio" ? audioDirectory : mediaDirectory;
  if (record) {
    await unlink(path.join(directory, record.storage_name)).catch(() => undefined);
    if (/\.aiff?$/i.test(record.original_name || record.storage_name) || String(record.mime_type || "").toLowerCase() === "audio/x-aiff") {
      await unlink(path.join(directory, `.${id}-${record.updated_at}.playback.wav`)).catch(() => undefined);
    }
  }
  removeStoredFile(type, id);
  sendJson(req, res, 200, { ok: true });
}

async function fetchJson(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Peer returned ${response.status}`);
  return body;
}

async function pairWithInvite(code) {
  const invitation = decodePairingInvite(code);
  const account = getAccount();
  if (!account.peerUrl || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(account.peerUrl)) throw new Error("Set this instance's mesh VPN URL before pairing");
  const tokenForRemote = randomBytes(32).toString("base64url");
  const response = await fetchJson(`${invitation.peerUrl}/api/peer/accept`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ inviteToken: invitation.token, peer: account, tokenForRemote }),
  });
  upsertFriend(response.account, tokenForRemote, response.tokenForCaller);
  return response.account;
}

async function downloadPeerAudio(friend, demoUuid) {
  const demo = demoByUuid(demoUuid);
  if (!demo || getStoredFile("audio", Number(demo.id))) return false;
  const response = await fetch(`${friend.peer_url}/api/peer/audio/${encodeURIComponent(demoUuid)}`, {
    headers: { authorization: `Bearer ${friend.outbound_token}` }, signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !response.body) return false;
  const originalName = safeFileName(response.headers.get("x-file-name"));
  const extension = path.extname(originalName).slice(0, 12).replace(/[^.a-zA-Z0-9]/g, "");
  const storageName = `${demo.id}${extension}`;
  const temporary = path.join(audioDirectory, `.${demo.id}-${Date.now()}.peer`);
  const destination = path.join(audioDirectory, storageName);
  const hash = createHash("sha256");
  const checksumStream = new Transform({ transform(chunk, encoding, callback) { hash.update(chunk); callback(null, chunk); } });
  try {
    await pipeline(Readable.fromWeb(response.body), checksumStream, createWriteStream(temporary, { flags: "wx" }));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  const checksum = hash.digest("hex");
  if (demo.checksum && checksum !== demo.checksum) {
    await unlink(temporary).catch(() => undefined);
    throw new Error(`Audio checksum mismatch for ${demo.title}`);
  }
  await rename(temporary, destination);
  const details = await stat(destination);
  saveStoredFile("audio", Number(demo.id), storageName, originalName, response.headers.get("content-type") || "application/octet-stream", details.size);
  markPeerAudioStored(Number(demo.id), originalName, details.size);
  return true;
}

async function syncFriend(friendId) {
  const friend = friendWithSecrets(friendId);
  if (!friend) throw new Error("Friend not found");
  try {
    const incoming = await fetchJson(`${friend.peer_url}/api/peer/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${friend.outbound_token}`, "content-type": "application/json" },
      body: JSON.stringify(buildSyncPackage(friendId)),
    });
    const mergeResult = mergeSyncPackage(friendId, incoming);
    for (const file of mergeResult.revokedFiles) {
      await unlink(path.join(audioDirectory, file.storageName)).catch(() => undefined);
      await unlink(path.join(audioDirectory, file.derivativeName)).catch(() => undefined);
    }
    let audioCopied = 0;
    for (const uuid of mergeResult.audioUuids) if (await downloadPeerAudio(friend, uuid)) audioCopied++;
    return { ok: true, audioCopied, workspace: readWorkspace() };
  } catch (error) {
    markFriendSyncError(friendId);
    throw error;
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${host}:${port}`);
    if (req.method === "OPTIONS") { res.writeHead(204, corsHeaders(req)); return res.end(); }
    if (!url.pathname.startsWith("/api/peer/") && !isOwnerApiRequest(req)) return sendJson(req, res, 403, { error: "This endpoint is available only through the owner gateway" });
    if (req.method === "GET" && url.pathname === "/api/health") return sendJson(req, res, 200, { ok: true, database: "sqlite", peerSync: true });
    if (req.method === "GET" && url.pathname === "/api/state") return sendJson(req, res, 200, readWorkspace());
    if (req.method === "PUT" && url.pathname === "/api/state") {
      writeWorkspace(await readJson(req));
      return sendJson(req, res, 200, { ok: true });
    }
    if (req.method === "PUT" && url.pathname === "/api/account") return sendJson(req, res, 200, updateAccount(await readJson(req)));
    if (req.method === "POST" && url.pathname === "/api/feedback/seen") return sendJson(req, res, 200, markFeedbackSeen((await readJson(req)).seenAt));
    if (req.method === "POST" && url.pathname === "/api/remote/sessions") return sendJson(req, res, 201, createRemoteSession());
    const remoteCommandRoute = url.pathname.match(/^\/api\/remote\/sessions\/([A-Za-z0-9_-]{24,80})\/commands$/);
    if (req.method === "POST" && remoteCommandRoute) {
      const command = await readJson(req);
      const allowed = new Set(["play-pause", "previous", "next", "skip", "up", "down", "seek"]);
      if (!allowed.has(command?.type)) return sendJson(req, res, 400, { error: "Unsupported remote command" });
      if (command.type === "seek" && (!Number.isFinite(Number(command.seconds)) || Number(command.seconds) < 0 || Number(command.seconds) > 86_400)) return sendJson(req, res, 400, { error: "Invalid seek position" });
      return sendJson(req, res, 202, sendRemoteCommand(remoteCommandRoute[1], command));
    }
    const remoteSessionRoute = url.pathname.match(/^\/api\/remote\/sessions\/([A-Za-z0-9_-]{24,80})$/);
    if (remoteSessionRoute && req.method === "GET") return sendJson(req, res, 200, getRemoteSession(remoteSessionRoute[1], Number(url.searchParams.get("after") || 0)));
    if (remoteSessionRoute && req.method === "PUT") { const body = await readJson(req); return sendJson(req, res, 200, updateRemoteSessionState(remoteSessionRoute[1], body.state, body.afterSequence)); }
    if (remoteSessionRoute && req.method === "DELETE") { closeRemoteSession(remoteSessionRoute[1]); return sendJson(req, res, 200, { ok: true }); }
    if (req.method === "POST" && url.pathname === "/api/invites") return sendJson(req, res, 201, { code: createPairingInvite() });
    if (req.method === "POST" && url.pathname === "/api/friends/pair") return sendJson(req, res, 201, { friend: await pairWithInvite((await readJson(req)).code) });
    const syncRoute = url.pathname.match(/^\/api\/friends\/([^/]+)\/sync$/);
    if (req.method === "POST" && syncRoute) return sendJson(req, res, 200, await syncFriend(decodeURIComponent(syncRoute[1])));
    const friendRoute = url.pathname.match(/^\/api\/friends\/([^/]+)$/);
    if (req.method === "DELETE" && friendRoute) {
      removeFriend(decodeURIComponent(friendRoute[1]));
      return sendJson(req, res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/peer/accept") return sendJson(req, res, 201, acceptPairing(await readJson(req)));
    if (req.method === "POST" && url.pathname === "/api/peer/sync") {
      const peer = requirePeer(req);
      const incoming = await readJson(req);
      const mergeResult = mergeSyncPackage(peer.id, incoming);
      for (const file of mergeResult.revokedFiles) {
        await unlink(path.join(audioDirectory, file.storageName)).catch(() => undefined);
        await unlink(path.join(audioDirectory, file.derivativeName)).catch(() => undefined);
      }
      return sendJson(req, res, 200, buildSyncPackage(peer.id));
    }
    const peerAudioRoute = url.pathname.match(/^\/api\/peer\/audio\/([^/]+)$/);
    if (req.method === "GET" && peerAudioRoute) {
      const peer = requirePeer(req);
      const demoUuid = decodeURIComponent(peerAudioRoute[1]);
      if (!canFriendAccessAudio(peer.id, demoUuid)) return sendJson(req, res, 403, { error: "This audio is not shared with this friend" });
      const demo = demoByUuid(demoUuid);
      return await serveFile(req, res, "audio", Number(demo.id));
    }
    if (req.method === "GET" && url.pathname === "/api/storage") {
      const filesystem = await statfs(dataDirectory);
      const usage = storedFileBytes() + (await stat(databasePath)).size;
      return sendJson(req, res, 200, {
        usage, quota: Number(filesystem.bavail) * Number(filesystem.bsize) + usage, persisted: true,
      });
    }
    const fileRoute = routeFile(url);
    if (fileRoute && req.method === "POST") return await uploadFile(req, res, fileRoute.type, fileRoute.id);
    if (fileRoute && (req.method === "GET" || req.method === "HEAD")) return await serveFile(req, res, fileRoute.type, fileRoute.id);
    if (fileRoute && req.method === "DELETE") return await deleteFile(req, res, fileRoute.type, fileRoute.id);
    sendJson(req, res, 404, { error: "Not found" });
  } catch (error) {
    if (res.destroyed || res.headersSent) return res.destroy();
    sendJson(req, res, error?.statusCode || 500, { error: error instanceof Error ? error.message : "Internal error" });
  }
});

server.on("error", (error) => {
  process.stderr.write(`[demolition] Could not bind the local API at ${host}:${port}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  process.stdout.write(`[demolition] Local SQLite API running at http://${host}:${port}\n`);
});
