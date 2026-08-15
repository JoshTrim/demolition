import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, stat, statfs, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  acceptPairing, audioDirectory, authenticatePeer, buildSyncPackage, canFriendAccessAudio,
  createPairingInvite, dataDirectory, decodePairingInvite, demoByUuid, friendWithSecrets,
  getAccount, getStoredFile, markFriendSyncError, markPeerAudioStored, mediaDirectory,
  mergeSyncPackage, readWorkspace, removeFriend, removeStoredFile, saveStoredFile,
  storedFileBytes, updateAccount, upsertFriend, writeWorkspace,
} from "./database.mjs";

const port = Number(process.env.DEMOLITION_API_PORT || 3001);
const host = process.env.DEMOLITION_API_HOST || "127.0.0.1";

function corsHeaders(req) {
  const origin = req.headers.origin;
  const allowed = origin && /^http:\/\/(localhost|127\.0\.0\.1|\[[a-f0-9:]+\]|(?:\d{1,3}\.){3}\d{1,3})(:\d+)?$/i.test(origin)
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
  await pipeline(req, createWriteStream(temporary, { flags: "wx" }));
  const previous = getStoredFile(type, id);
  if (previous && previous.storage_name !== storageName) await unlink(path.join(directory, previous.storage_name)).catch(() => undefined);
  await rename(temporary, destination);
  const details = await stat(destination);
  saveStoredFile(type, id, storageName, originalName, req.headers["content-type"] || "application/octet-stream", details.size);
  sendJson(req, res, 201, { ok: true, size: details.size });
}

async function serveFile(req, res, type, id, extraHeaders = {}) {
  const record = getStoredFile(type, id);
  const directory = type === "audio" ? audioDirectory : mediaDirectory;
  if (!record) return sendJson(req, res, 404, { error: "File not found" });
  const filePath = path.join(directory, record.storage_name);
  if (!existsSync(filePath)) return sendJson(req, res, 404, { error: "File not found" });
  res.writeHead(200, {
    ...corsHeaders(req), ...extraHeaders, "content-type": record.mime_type, "content-length": String(record.size_bytes),
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(record.original_name)}`,
    "x-file-name": encodeURIComponent(record.original_name),
  });
  if (req.method === "HEAD") return res.end();
  createReadStream(filePath).pipe(res);
}

async function deleteFile(req, res, type, id) {
  const record = getStoredFile(type, id);
  const directory = type === "audio" ? audioDirectory : mediaDirectory;
  if (record) await unlink(path.join(directory, record.storage_name)).catch(() => undefined);
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
  await pipeline(Readable.fromWeb(response.body), checksumStream, createWriteStream(temporary, { flags: "wx" }));
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
    const audioUuids = mergeSyncPackage(friendId, incoming);
    let audioCopied = 0;
    for (const uuid of audioUuids) if (await downloadPeerAudio(friend, uuid)) audioCopied++;
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
    if (!url.pathname.startsWith("/api/peer/") && !isLocalRequest(req)) return sendJson(req, res, 403, { error: "This endpoint is available only on the local machine" });
    if (req.method === "GET" && url.pathname === "/api/health") return sendJson(req, res, 200, { ok: true, database: "sqlite", peerSync: true });
    if (req.method === "GET" && url.pathname === "/api/state") return sendJson(req, res, 200, readWorkspace());
    if (req.method === "PUT" && url.pathname === "/api/state") {
      writeWorkspace(await readJson(req));
      return sendJson(req, res, 200, { ok: true });
    }
    if (req.method === "PUT" && url.pathname === "/api/account") return sendJson(req, res, 200, updateAccount(await readJson(req)));
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
      mergeSyncPackage(peer.id, incoming);
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
      const usage = storedFileBytes() + (await stat(path.join(dataDirectory, "demolition.sqlite"))).size;
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
    sendJson(req, res, error?.statusCode || 500, { error: error instanceof Error ? error.message : "Internal error" });
  }
});

server.listen(port, host, () => {
  process.stdout.write(`[demolition] Local SQLite API running at http://${host}:${port}\n`);
});
