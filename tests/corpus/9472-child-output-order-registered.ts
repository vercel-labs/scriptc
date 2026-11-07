// The order of 'data' events when a child's pipes filled before the parent
// went back to its loop: the order the pipes were created, stdout before
// stderr and an older child's before a newer one's, whatever the child wrote
// first and whichever listener was attached first. Node starts reading a
// child's pipes when spawn() creates them and registers them with its kernel
// queue at the next poll, in that order, and a pipe that is already readable
// joins the ready queue when it is registered. That is an accident of
// registration, and the native loop matches it.
//
// The parent computes until the child has created a marker file, which the
// child does after its last write, so every write is in the pipes before the
// parent's next poll, however slow the machine.
//
// Several children that have all exited by then fire 'exit' in spawn order
// and then 'close' in reverse (Node's 'close' for a child with pipes comes
// from libuv's closing queue, last closed first). Children whose pipes
// ended in an earlier turn have nothing left to close: each 'close' follows
// its 'exit'.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scriptc-child-order-"));
let markers = 0;

function computeUntil(marker: string): boolean {
  const start = Date.now();
  while (!existsSync(marker)) {
    if (Date.now() - start > 20000) return false;
  }
  return true;
}

function run(script: string, stderrFirst: boolean): Promise<string> {
  return new Promise((resolve) => {
    const marker = join(dir, `m${markers++}`);
    const seen: string[] = [];
    const child = spawn("/bin/sh", ["-c", `${script}; : > "$1"`, "sh", marker], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const onStdout = (chunk: Buffer): void => {
      seen.push(`stdout:${chunk.toString().trim().split("\n").join("|")}`);
    };
    const onStderr = (chunk: Buffer): void => {
      seen.push(`stderr:${chunk.toString().trim().split("\n").join("|")}`);
    };
    if (stderrFirst) {
      child.stderr!.on("data", onStderr);
      child.stdout!.on("data", onStdout);
    } else {
      child.stdout!.on("data", onStdout);
      child.stderr!.on("data", onStderr);
    }
    child.on("close", (code) => {
      resolve(`${seen.join(" ")} close:${code}`);
    });
    if (!computeUntil(marker)) seen.push("no marker");
  });
}

// True once the process is a zombie (or gone): it has exited and nobody has
// reaped it, which the parent only does from its loop.
function exited(pid: number): boolean {
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  return state === "" || state.startsWith("Z");
}

// Three children. The last one spawned writes first and the first one last;
// each waits for the marker of the one before it. The parent computes until
// all three have exited.
function runThree(): Promise<string> {
  return new Promise((resolve) => {
    const seen: string[] = [];
    const names = ["a", "b", "c"];
    const marks = names.map((name) => join(dir, `three-${name}`));
    const pids: number[] = [];
    let open = 3;
    for (let i = 0; i < 3; i++) {
      const name = names[i];
      const wait = i === 2 ? ":" : `while [ ! -e "$2" ]; do sleep 0.01; done`;
      const script = `${wait}; echo ${name}err 1>&2; echo ${name}; : > "$1"`;
      const child = spawn("/bin/sh", ["-c", script, "sh", marks[i], i === 2 ? "" : marks[i + 1]], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      pids.push(child.pid ?? 0);
      child.stdout!.on("data", (chunk: Buffer) => {
        seen.push(`${name}.stdout:${chunk.toString().trim()}`);
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        seen.push(`${name}.stderr:${chunk.toString().trim()}`);
      });
      child.on("exit", () => {
        seen.push(`${name}.exit`);
      });
      child.on("close", () => {
        seen.push(`${name}.close`);
        if (--open === 0) resolve(seen.join(" "));
      });
    }
    if (!computeUntil(marks[0])) seen.push("no marker");
    const start = Date.now();
    while (!pids.every(exited)) {
      if (Date.now() - start > 20000) {
        seen.push("still running");
        break;
      }
    }
  });
}

// The same without pipes: nothing to wait for, so each 'close' follows its
// 'exit'.
function runThreeIgnored(): Promise<string> {
  return new Promise((resolve) => {
    const seen: string[] = [];
    const names = ["a", "b", "c"];
    const pids: number[] = [];
    let open = 3;
    for (let i = 0; i < 3; i++) {
      const name = names[i];
      const child = spawn("/bin/sh", ["-c", `exit ${i}`], { stdio: "ignore" });
      pids.push(child.pid ?? 0);
      child.on("spawn", () => {
        seen.push(`${name}.spawn`);
      });
      child.on("exit", (code) => {
        seen.push(`${name}.exit:${code}`);
      });
      child.on("close", () => {
        seen.push(`${name}.close`);
        if (--open === 0) resolve(seen.join(" "));
      });
    }
    const start = Date.now();
    while (!pids.every(exited)) {
      if (Date.now() - start > 20000) {
        seen.push("still running");
        break;
      }
    }
  });
}

// Three children that close both output pipes at once and exit later, all
// in one turn of the parent. The parent waits in its loop until every pipe
// has ended, tells the children to exit two timers later, and computes
// until all three have.
function runThreeClosedEarly(): Promise<string> {
  return new Promise((resolve) => {
    const seen: string[] = [];
    const names = ["a", "b", "c"];
    const marker = join(dir, "closed-early");
    const pids: number[] = [];
    let open = 3;
    let ended = 0;
    const onEnd = (): void => {
      if (++ended < 6) return;
      setTimeout(() => {
        setTimeout(() => {
          writeFileSync(marker, "");
          const start = Date.now();
          while (!pids.every(exited)) {
            if (Date.now() - start > 20000) {
              seen.push("still running");
              break;
            }
          }
        }, 10);
      }, 10);
    };
    for (let i = 0; i < 3; i++) {
      const name = names[i];
      const script = 'exec 1>&- 2>&-; while [ ! -e "$1" ]; do sleep 0.01; done';
      const child = spawn("/bin/sh", ["-c", script, "sh", marker], { stdio: ["ignore", "pipe", "pipe"] });
      pids.push(child.pid ?? 0);
      child.stdout!.on("data", () => {});
      child.stdout!.on("end", onEnd);
      child.stderr!.on("data", () => {});
      child.stderr!.on("end", onEnd);
      child.on("exit", () => {
        seen.push(`${name}.exit`);
      });
      child.on("close", () => {
        seen.push(`${name}.close`);
        if (--open === 0) resolve(seen.join(" "));
      });
    }
  });
}

async function main(): Promise<void> {
  console.log("wrote err, out:", await run("echo err 1>&2; echo out", false));
  console.log("wrote out, err:", await run("echo out; echo err 1>&2", false));
  console.log("wrote err, out, stderr listener first:", await run("echo err 1>&2; echo out", true));
  console.log("wrote out, err, stderr listener first:", await run("echo out; echo err 1>&2", true));
  console.log("wrote out, err, out:", await run("echo a; echo b 1>&2; echo c", false));
  console.log("wrote err, out, err:", await run("echo a 1>&2; echo b; echo c 1>&2", false));
  console.log("three children:", await runThree());
  console.log("three children, no pipes:", await runThreeIgnored());
  console.log("three children, pipes ended a turn earlier:", await runThreeClosedEarly());
  rmSync(dir, { recursive: true, force: true });
}
main();
