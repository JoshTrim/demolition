import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import path from "node:path";

function portIsOccupied(port, host) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (occupied) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(occupied);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", (error) => finish(!["ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"].includes(error.code)));
    socket.setTimeout(250, () => finish(true));
  });
}

async function configureApiPort(environment) {
  if (environment.DEMOLITION_API_PORT) return;
  for (let port = 3001; port < 3100; port++) {
    const occupied = await Promise.all(["127.0.0.1", "::1"].map((host) => portIsOccupied(port, host)));
    if (occupied.some(Boolean)) continue;
    environment.DEMOLITION_API_PORT = String(port);
    if (port !== 3001) process.stdout.write(`[demolition] API port 3001 is busy; using ${port} instead.\n`);
    return;
  }
  throw new Error("Could not find an available Demolition API port between 3001 and 3099");
}

const mode = process.argv[2] === "dev" ? "dev" : "start";
const executable = path.resolve("node_modules/.bin/vinext");
const environment = { ...process.env, WRANGLER_LOG_PATH: ".wrangler/wrangler.log" };
await configureApiPort(environment);
environment.NEXT_PUBLIC_DEMOLITION_API_PORT = environment.DEMOLITION_API_PORT || "3001";
const vinextArgs = [mode];
if (environment.DEMOLITION_UI_HOST) vinextArgs.push("--hostname", environment.DEMOLITION_UI_HOST);
const children = [
  spawn(process.execPath, ["server/index.mjs"], { stdio: "inherit", env: environment }),
  spawn(executable, vinextArgs, { stdio: "inherit", env: environment }),
];

let stopping = false;
function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (!child.killed) child.kill(signal);
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(signal));
for (const child of children) child.on("exit", (code) => {
  if (!stopping && code !== 0) {
    stop();
    process.exitCode = code ?? 1;
  }
});

await Promise.all(children.map((child) => new Promise((resolve) => child.on("exit", resolve))));
