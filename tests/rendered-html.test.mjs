import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Demolition workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Demolition<\/title>/i);
  assert.match(html, /Demo library/);
  assert.match(html, /Local SQLite library/);
  assert.match(html, /Bulk import/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|A little attention goes a long way/i);
});

test("uses the local SQLite and managed-file backend", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "demolition-db-test-"));
  const databaseModule = new URL("../server/database.mjs", import.meta.url).href;
  const script = `
    const database = await import(${JSON.stringify(databaseModule)} + "?test=" + Date.now());
    database.writeWorkspace({
      projects: [{ name: "Album", color: "blue", mood: "" }],
      demos: [{ id: 1, title: "Test 12.4.19", bpm: 120, key: "C", duration: "01:00", status: "unheard", tags: ["test"], note: "", nextAction: "", rating: 0, project: "Album", updatedAt: 1, creationDate: "2019-04-12" }],
      orders: { Album: [1] }, media: []
    });
    const state = database.readWorkspace();
    if (state.projects[0].name !== "Album" || state.demos[0].creationDate !== "2019-04-12" || state.orders.Album[0] !== 1) process.exit(1);
  `;
  await run(process.execPath, ["--input-type=module", "-e", script], { cwd: temporaryDirectory });
});

test("keeps local data out of version control", async () => {
  const [ignore, packageJson, page] = await Promise.all([
    readFile(new URL("../.gitignore", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(ignore, /^\/data\/$/m);
  assert.match(packageJson, /scripts\/run-local\.mjs/);
  assert.match(page, /\/api\/state/);
  assert.doesNotMatch(page, /localStorage\.setItem\(STORAGE_KEY/);
});
