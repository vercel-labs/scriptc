// @requires-libnode
// The events and the lifecycle members of a child process a Node island started, read natively:
// 'spawn' first, output before 'exit', 'exit' before 'close', with the code and signal Node reports,
// and exitCode, signalCode, killed, pid, connected, spawnfile and spawnargs as they are at each
// point. Only the narrow stream members are used here (on "data" / "end"), so the streams are the
// child's own handles and not general streams.
import type { ChildProcess } from "node:child_process";
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

function state(child: ChildProcess): string {
  return `exitCode=${child.exitCode} signalCode=${child.signalCode} killed=${child.killed} pid=${typeof child.pid} connected=${child.connected}`;
}

function watch(name: string, child: ChildProcess, after?: (child: ChildProcess) => void): Promise<void> {
  return new Promise((resolve) => {
    const log: string[] = [`start ${state(child)}`];
    let out = "";
    let err = "";
    child.on("spawn", () => log.push("spawn"));
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on("error", (error) => log.push(`error:${error.message}`));
    child.on("exit", (code, signal) => log.push(`exit:${code}:${signal} ${state(child)}`));
    child.on("close", (code, signal) => {
      log.push(`close:${code}:${signal} out=${JSON.stringify(out)} err=${JSON.stringify(err)}`);
      console.log(`${name}:`);
      for (const line of log) console.log("  " + line);
      console.log("  spawnfile", child.spawnfile, "spawnargs", JSON.stringify(child.spawnargs));
      resolve();
    });
    if (after) after(child);
  });
}

async function main(): Promise<void> {
  await watch("ok", lib.start("echo hello"));
  await watch("code", lib.start("echo e >&2; exit 3"));
  await watch("killed", lib.start("exec sleep 30"), (child) => {
    setTimeout(() => console.log("  kill ->", child.kill(), "killed", child.killed), 50);
  });
  await watch("signal by name", lib.start("exec sleep 30"), (child) => {
    setTimeout(() => console.log("  kill(SIGKILL) ->", child.kill("SIGKILL")), 50);
  });
  await watch("self-terminated", lib.start("kill -TERM $$"));
  // kill after the exit answers false; an unknown signal name throws Node's error.
  const done: ChildProcess = lib.start("true");
  await new Promise<void>((resolve) => done.on("close", () => resolve()));
  console.log("kill after close ->", done.kill(), "killed", done.killed);
  try {
    done.kill("SIGNOPE");
  } catch (error) {
    console.log("unknown signal ->", (error as NodeJS.ErrnoException).code, (error as Error).message);
  }
  // ref and unref are the island child's: an unref'd child does not keep the program alive.
  const lingering: ChildProcess = lib.start("exec sleep 30");
  lingering.unref();
  lingering.ref();
  lingering.unref();
  setTimeout(() => lingering.kill(), 20);
}
main();
