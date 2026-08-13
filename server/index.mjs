import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, stat, statfs, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import {
  audioDirectory, dataDirectory, getStoredFile, mediaDirectory, readWorkspace,
  removeStoredFile, saveStoredFile, storedFileBytes, writeWorkspace,
} from "./database.mjs";

const port = Number(process.env.DEMOLITION_API_PORT || 3001);
const host = "127.0.0.1";

function corsHeaders(req) {
  const origin = req.headers.origin;
  const allowed = origin === "http://localhost:3000" || origin === "http://127.0.0.1:3000" ? origin : "http://localhost:3000";
  return {
    "access-control-allow-origin": allowed,
    "access-control-allow-methods": "GET, HEAD, PUT, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, x-file-name",
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

async function serveFile(req, res, type, id) {
  const record = getStoredFile(type, id);
  const directory = type === "audio" ? audioDirectory : mediaDirectory;
  if (!record) return sendJson(req, res, 404, { error: "File not found" });
  const filePath = path.join(directory, record.storage_name);
  if (!existsSync(filePath)) return sendJson(req, res, 404, { error: "File not found" });
  res.writeHead(200, {
    ...corsHeaders(req), "content-type": record.mime_type, "content-length": String(record.size_bytes),
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(record.original_name)}`,
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

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${host}:${port}`);
    if (req.method === "OPTIONS") { res.writeHead(204, corsHeaders(req)); return res.end(); }
    if (req.method === "GET" && url.pathname === "/api/health") return sendJson(req, res, 200, { ok: true, database: "sqlite" });
    if (req.method === "GET" && url.pathname === "/api/state") return sendJson(req, res, 200, readWorkspace());
    if (req.method === "PUT" && url.pathname === "/api/state") {
      writeWorkspace(await readJson(req));
      return sendJson(req, res, 200, { ok: true });
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
    sendJson(req, res, 500, { error: error instanceof Error ? error.message : "Internal error" });
  }
});

server.listen(port, host, () => {
  process.stdout.write(`[demolition] Local SQLite API running at http://${host}:${port}\n`);
});
