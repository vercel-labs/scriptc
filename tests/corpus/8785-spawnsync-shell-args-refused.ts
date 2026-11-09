// @normalize-pid
// spawnSync and spawn with the shell enabled, separate arguments, and a
// value Node refuses. normalizeSpawnArguments checks the file, the arguments and cwd
// before it joins the arguments onto the command and reports DEP0190, and
// it checks the environment after. So a refused file, argument or cwd
// reports no warning and leaves the once-per-process warning to a later
// call, and a refused environment has already reported it.
import { spawn, spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";

let seen = 0;
process.on("warning", (warning) => {
  seen++;
  console.log("warning:", warning.name, (warning as { code?: string }).code);
});
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// Values the compiler does not know.
const nul: string = ["a", "b"].join("\0");
const empty: string = nul.slice(0, 0);

function refused(label: string, launch: () => unknown): void {
  try {
    launch();
    console.log(label, "returned");
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    console.log(label, "threw", e.name, e.code, JSON.stringify(e.message));
  }
}

async function main(): Promise<void> {
  // An inline `shell: true`.
  refused("argument", () => spawnSync("echo", ["x", nul], { encoding: "utf8", shell: true }));
  refused("file", () => spawnSync(nul, ["x"], { encoding: "utf8", shell: true }));
  refused("empty file", () => spawnSync(empty, ["x"], { encoding: "utf8", shell: true }));
  refused("cwd", () => spawnSync("echo", ["x"], { encoding: "utf8", shell: true, cwd: nul }));
  await tick();
  console.log("warnings after a refused file, argument or cwd:", seen);

  // The shell decided by a typed options value.
  const on: SpawnSyncOptionsWithStringEncoding = { encoding: "utf8", shell: true };
  const onCwd: SpawnSyncOptionsWithStringEncoding = { encoding: "utf8", shell: true, cwd: nul };
  refused("typed argument", () => spawnSync("echo", ["x", nul], on));
  refused("typed file", () => spawnSync(nul, ["x"], on));
  refused("typed cwd", () => spawnSync("echo", ["x"], onCwd));
  await tick();
  console.log("warnings after the typed refusals:", seen);

  // spawn checks the same values before it joins, with the shell always on
  // and with a shell decided at run time.
  const flag: boolean = nul.length === 3;
  refused("spawn argument", () => spawn("echo", ["x", nul], { shell: true }));
  refused("spawn file", () => spawn(empty, ["x"], { shell: true }));
  refused("spawn argument, shell at run time", () => spawn("echo", ["x", nul], { shell: flag }));
  refused("spawn cwd, shell at run time", () => spawn("echo", ["x"], { shell: flag, cwd: nul }));
  await tick();
  console.log("warnings after spawn's refusals:", seen);

  // The environment is checked after the line is built: the warning is out.
  const onEnv: SpawnSyncOptionsWithStringEncoding = {
    encoding: "utf8",
    shell: true,
    env: { A: nul },
  };
  refused("typed env", () => spawnSync("echo", ["x"], onEnv));
  console.log("before the tick:", seen);
  await tick();
  console.log("after a refused environment:", seen);
  refused("env", () =>
    spawnSync("echo", ["x"], { encoding: "utf8", shell: true, env: { A: nul } }),
  );
  await tick();
  console.log("after a second one:", seen);

  // A launch Node accepts still joins its arguments, silently now.
  console.log(JSON.stringify(spawnSync("echo", ["joined", "$((1+2))"], on).stdout));
  console.log(
    JSON.stringify(spawnSync("echo", ["inline", String(nul.length)], { encoding: "utf8", shell: true }).stdout),
  );
  await tick();
  console.log("once per process:", seen);
}

main();
