// @normalize-pid
// DEP0190 as process.emitWarning delivers it: on the next tick, to the
// 'warning' listeners and the default stderr report, once per process, and
// only for a call that has the shell on AND a non-empty argument list.
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";

let seen = 0;
process.on("warning", (warning) => {
  seen++;
  console.log("warning:", warning.name, (warning as { code?: string }).code, warning.message);
});

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function main(): Promise<void> {
  const off: SpawnSyncOptionsWithStringEncoding = { encoding: "utf8", shell: false };
  const on: SpawnSyncOptionsWithStringEncoding = { encoding: "utf8", shell: true };
  const args = ["one", "two"];
  const empty: string[] = [];

  spawnSync("/bin/echo", args, off);
  await tick();
  console.log("shell off with arguments:", seen);

  spawnSync("echo one", empty, on);
  spawnSync("echo one", [], on);
  await tick();
  console.log("shell on with an empty list:", seen);

  console.log(JSON.stringify(spawnSync("echo", args, on).stdout));
  console.log("before the tick:", seen);
  await tick();
  console.log("after the tick:", seen);

  spawnSync("echo", args, on);
  spawnSync("echo", ["lit"], { encoding: "utf8", shell: true });
  await tick();
  console.log("once per process:", seen);
}

main();
