import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
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
  assert.match(html, /Manage tags/);
  assert.match(html, /Listen mode/);
  assert.doesNotMatch(html, /out of 5 stars|Unrated/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|A little attention goes a long way/i);
});

test("uses the local SQLite and managed-file backend", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "demolition-db-test-"));
  const databasePath = path.join(temporaryDirectory, "database", "demolition.sqlite");
  const databaseModule = new URL("../server/database.mjs", import.meta.url).href;
  const script = `
    const database = await import(${JSON.stringify(databaseModule)} + "?test=" + Date.now());
    const account = database.getAccount();
    database.writeWorkspace({
      projects: [{ name: "Album", color: "blue", mood: "" }],
      demos: [{ id: 1, uuid: "demo-one", ownerId: account.id, title: "Test 12.4.19", bpm: 120, key: "C", duration: "01:00", status: "unheard", tags: ["test"], note: "", nextAction: "", rating: 0, project: "Album", updatedAt: 1, creationDate: "2019-04-12" }],
      orders: { Album: [1] }, media: [],
      shares: [], listens: [{ id: 2, eventUuid: "listen-one", demoId: 1, demoUuid: "demo-one", authorId: account.id, authorName: account.displayName, verdict: "up", note: "Strong chorus", listenedAt: 2 }],
      timedNotes: [{ id: 3, noteUuid: "note-one", demoId: 1, demoUuid: "demo-one", authorId: account.id, authorName: account.displayName, startSeconds: 10, endSeconds: 18.5, note: "Bass change", createdAt: 3 }]
    });
    const state = database.readWorkspace();
    if (state.projects[0].name !== "Album" || state.tags[0].name !== "test" || state.demos[0].creationDate !== "2019-04-12" || state.demos[0].uuid !== "demo-one" || state.orders.Album[0] !== 1 || state.listens[0].verdict !== "up" || state.listens[0].note !== "Strong chorus" || state.listens[0].authorId !== account.id || !state.listens[0].signature || state.timedNotes[0].endSeconds !== 18.5 || !state.timedNotes[0].signature) process.exit(1);
  `;
  await run(process.execPath, ["--input-type=module", "-e", script], {
    cwd: temporaryDirectory,
    env: { ...process.env, DEMOLITION_DATABASE_PATH: databasePath },
  });
  assert.equal((await stat(databasePath)).isFile(), true);
});

test("pairs local identities and exchanges signed ratings", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "demolition-peers-test-"));
  const firstDirectory = path.join(temporaryDirectory, "first");
  const secondDirectory = path.join(temporaryDirectory, "second");
  await Promise.all([mkdir(firstDirectory), mkdir(secondDirectory)]);
  const databaseModule = new URL("../server/database.mjs", import.meta.url).href;
  const script = `
    process.chdir(${JSON.stringify(firstDirectory)});
    const first = await import(${JSON.stringify(databaseModule)} + "?peer=first-" + Date.now());
    first.updateAccount({ displayName: "Alex", peerUrl: "http://first.mesh:3001" });
    process.chdir(${JSON.stringify(secondDirectory)});
    const second = await import(${JSON.stringify(databaseModule)} + "?peer=second-" + Date.now());
    second.updateAccount({ displayName: "Blair", peerUrl: "http://second.mesh:3001" });
    const invitation = second.decodePairingInvite(first.createPairingInvite());
    const firstAccount = first.getAccount();
    const secondAccount = second.getAccount();
    const tokenForFirst = "second-accepts-first-token";
    const accepted = first.acceptPairing({ inviteToken: invitation.token, peer: secondAccount, tokenForRemote: tokenForFirst });
    second.upsertFriend(accepted.account, tokenForFirst, accepted.tokenForCaller);
    first.writeWorkspace({
      projects: [], tags: [], orders: {}, media: [],
      demos: [{ id: 1, uuid: "shared-demo", ownerId: firstAccount.id, title: "Shared", bpm: 110, key: "D", duration: "01:00", status: "unheard", tags: [], note: "", nextAction: "", project: "Unsorted", updatedAt: 1 }],
      listens: [{ id: 2, eventUuid: "alex-vote", demoId: 1, demoUuid: "shared-demo", authorId: firstAccount.id, authorName: "Alex", verdict: "up", note: "owner vote", listenedAt: 2 }],
      timedNotes: [{ id: 4, noteUuid: "alex-note", demoId: 1, demoUuid: "shared-demo", authorId: firstAccount.id, authorName: "Alex", startSeconds: 4, endSeconds: 9, note: "Intro texture", createdAt: 4 }],
      shares: [{ demoUuid: "shared-demo", friendId: secondAccount.id, shareAudio: false }]
    });
    second.mergeSyncPackage(firstAccount.id, first.buildSyncPackage(secondAccount.id));
    let secondState = second.readWorkspace();
    if (secondState.demos[0].ownerId !== firstAccount.id || secondState.listens[0].authorName !== "Alex" || secondState.timedNotes[0].note !== "Intro texture") process.exit(1);
    const remoteDemo = secondState.demos[0];
    second.writeWorkspace({ ...secondState, listens: [...secondState.listens, { id: 3, eventUuid: "blair-vote", demoId: remoteDemo.id, demoUuid: remoteDemo.uuid, authorId: secondAccount.id, authorName: "Blair", verdict: "down", note: "friend vote", listenedAt: 3 }], timedNotes: [...secondState.timedNotes, { id: 5, noteUuid: "blair-note", demoId: remoteDemo.id, demoUuid: remoteDemo.uuid, authorId: secondAccount.id, authorName: "Blair", startSeconds: 12, endSeconds: 17, note: "Try a shorter fill", createdAt: 5 }] });
    first.mergeSyncPackage(secondAccount.id, second.buildSyncPackage(firstAccount.id));
    const firstState = first.readWorkspace();
    if (!firstState.listens.some((listen) => listen.authorName === "Blair" && listen.verdict === "down" && listen.signature) || !firstState.timedNotes.some((note) => note.authorName === "Blair" && note.note === "Try a shorter fill" && note.signature)) process.exit(1);
  `;
  await run(process.execPath, ["--input-type=module", "-e", script], { cwd: temporaryDirectory });
});

test("restores a copied SQLite library and managed audio directory", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "demolition-restore-test-"));
  const sourceDirectory = path.join(temporaryDirectory, "source");
  const restoredDirectory = path.join(temporaryDirectory, "restored");
  await Promise.all([mkdir(sourceDirectory), mkdir(restoredDirectory)]);
  const databaseModule = new URL("../server/database.mjs", import.meta.url).href;
  const createScript = `
    import { writeFile } from "node:fs/promises";
    process.chdir(${JSON.stringify(sourceDirectory)});
    const database = await import(${JSON.stringify(databaseModule)} + "?backup-source=" + Date.now());
    const account = database.getAccount();
    database.writeWorkspace({
      projects: [], tags: [], orders: {}, media: [], listens: [], timedNotes: [], shares: [],
      demos: [{ id: 42, uuid: "restore-demo", ownerId: account.id, title: "Restore Me", bpm: 100, key: "A", duration: "00:10", status: "unheard", tags: [], note: "", nextAction: "", project: "Unsorted", updatedAt: 1, audioName: "restore.wav", checksum: "test-checksum", fileSize: 5 }]
    });
    await writeFile(new URL("data/audio/42.wav", "file://" + process.cwd() + "/"), Buffer.from("audio"));
    database.saveStoredFile("audio", 42, "42.wav", "restore.wav", "audio/wav", 5);
  `;
  await run(process.execPath, ["--input-type=module", "-e", createScript], { cwd: sourceDirectory });
  await cp(path.join(sourceDirectory, "data"), path.join(restoredDirectory, "data"), { recursive: true });
  const verifyScript = `
    import { readFile } from "node:fs/promises";
    process.chdir(${JSON.stringify(restoredDirectory)});
    const database = await import(${JSON.stringify(databaseModule)} + "?backup-restore=" + Date.now());
    const state = database.readWorkspace();
    const stored = database.getStoredFile("audio", 42);
    const audio = await readFile(new URL("data/audio/42.wav", "file://" + process.cwd() + "/"), "utf8");
    if (state.demos[0]?.uuid !== "restore-demo" || stored?.original_name !== "restore.wav" || audio !== "audio") process.exit(1);
  `;
  await run(process.execPath, ["--input-type=module", "-e", verifyScript], { cwd: restoredDirectory });
});

test("ships reverse-proxy upstreams and a WireGuard-bound peer API", async () => {
  const [compose, server, page, dockerfile] = await Promise.all([
    readFile(new URL("../compose.yaml", import.meta.url), "utf8"),
    readFile(new URL("../server/index.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../Dockerfile", import.meta.url), "utf8"),
  ]);
  assert.match(compose, /DEMOLITION_WIREGUARD_IP/);
  assert.match(compose, /DEMOLITION_DATABASE_DIR/);
  assert.match(compose, /DEMOLITION_DATABASE_PATH: \/app\/database\/demolition\.sqlite/);
  assert.match(compose, /DEMOLITION_PROXY_TOKEN/);
  assert.match(compose, /DEMOLITION_PROXY_NETWORK/);
  assert.match(compose, /external: true/);
  assert.match(compose, /127\.0\.0\.1:\$\{DEMOLITION_UI_PORT/);
  assert.match(compose, /127\.0\.0\.1:\$\{DEMOLITION_API_PORT/);
  assert.match(compose, /DEMOLITION_WIREGUARD_IP[\s\S]*DEMOLITION_API_PORT/);
  assert.doesNotMatch(compose, /caddy:/);
  assert.match(server, /isTrustedProxyRequest/);
  assert.match(page, /localDevelopment[\s\S]*: path/);
  assert.match(dockerfile, /node:22-bookworm-slim/);
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
  assert.match(page, /key === "arrowleft" \|\| key === "h"/);
  assert.match(page, /key === "arrowright" \|\| key === "l"/);
  assert.match(page, /key === "arrowdown" \|\| key === "j"/);
  assert.match(page, /key === "arrowup" \|\| key === "k"/);
  assert.match(page, /aria-label="Skip without rating"/);
  assert.match(page, />Skip <span>→<\/span>/);
  assert.match(page, /onEnded=\{advanceRapid\}/);
  assert.match(page, /onPointerDown=\{beginTimedNoteRange\}/);
  assert.match(page, /waveformPeaks/);
  assert.match(page, /libraryAudioChecksums/);
  assert.match(page, /Indexing existing demo/);
  assert.match(page, /uniqueFiles/);
  assert.match(page, /filenameKey/);
  assert.match(page, /showConflictReview/);
  assert.match(page, /deferFilenameConflicts/);
  assert.match(page, /Review conflicts/);
  assert.match(page, /FILENAME CONFLICT/);
  assert.match(page, /Audition both versions/);
  assert.match(page, /resolveFilenameConflict\("existing"\)/);
  assert.match(page, /resolveFilenameConflict\("incoming"\)/);
  assert.match(page, /resolveFilenameConflict\("both"\)/);
  assert.match(page, /annotation-waveform/);
  assert.match(page, /rapidActiveNoteUuids/);
  assert.match(page, /editTimedNote\(note\)/);
  assert.match(page, /deleteTimedNote\(note\)/);
  assert.match(page, /Update timed note/);
  assert.match(page, /Save timed note/);
  assert.match(page, /timedNotes/);
  assert.doesNotMatch(page, /localStorage\.setItem\(STORAGE_KEY/);
});
