import { spawn } from "node:child_process";
import path from "node:path";

const mode = process.argv[2] === "dev" ? "dev" : "start";
const executable = path.resolve("node_modules/.bin/vinext");
const environment = { ...process.env, WRANGLER_LOG_PATH: ".wrangler/wrangler.log" };
const children = [
  spawn(process.execPath, ["server/index.mjs"], { stdio: "inherit", env: environment }),
  spawn(executable, [mode], { stdio: "inherit", env: environment }),
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
