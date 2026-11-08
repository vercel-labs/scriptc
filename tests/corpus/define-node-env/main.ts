// @define: process.env.NODE_ENV="production"
// @define: process.env.SCRIPTC_FEATURE="on"
// React-style package entries that pick their build from NODE_ENV, built with it fixed: only the production modules load, and the program sees the defined value, whatever the binary's own environment holds.
import { spawnSync } from "node:child_process";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import envPkg from "env-pkg";
import { render, renderLegacy, version } from "env-pkg/server.js";
import propTypes from "env-pkg/prop-types.js";
import wrap from "./wrap.cjs";
import { label } from "./flags.mjs";

if (!isMainThread) {
  parentPort!.postMessage(process.env.NODE_ENV);
} else if (process.argv.at(2) === "child") {
  console.log("child", process.env.NODE_ENV);
} else {
  console.log(envPkg.greet("app"), envPkg.mode);
  console.log(render(), renderLegacy(), version);
  console.log(propTypes.checkPropTypes());
  console.log(wrap.local);
  console.log(label);
  console.log("main", process.env.NODE_ENV, process.env.SCRIPTC_FEATURE);
  const child = spawnSync(process.execPath, [process.argv[1]!, "child"], { encoding: "utf8" });
  console.log(child.stdout.trim());
  const worker = new Worker(new URL(import.meta.url));
  worker.on("message", (mode: string) => console.log("worker", mode));
}
