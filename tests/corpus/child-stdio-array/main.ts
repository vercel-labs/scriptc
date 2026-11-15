// subprocess.stdio: Node's one array per child, one entry per stdio slot.
// A piped slot holds the SAME object stdin/stdout/stderr answer, a slot that
// is not a pipe holds null, and a fork's fourth, IPC slot is null too while
// the array keeps length 4. Repeated reads answer the same array.
import { execFile, fork, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
const worker = fileURLToPath(new URL(`./worker.${extension}`, import.meta.url));

function closed(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve) => child.once("close", (code) => resolve(code)));
}

function show(label: string, child: ReturnType<typeof spawn>): void {
  const stdio = child.stdio;
  console.log(label, "length", stdio.length, "array", Array.isArray(stdio));
  console.log(label, "stable", stdio === child.stdio);
  console.log(
    label,
    "slots",
    stdio[0] === child.stdin,
    stdio[1] === child.stdout,
    stdio[2] === child.stderr,
  );
  console.log(label, "nulls", stdio[0] === null, stdio[1] === null, stdio[2] === null);
}

const piped = spawn("cat", []);
show("piped", piped);
piped.stdin?.end();
console.log("piped close", await closed(piped));

const ignored = spawn("cat", [], { stdio: "ignore" });
show("ignored", ignored);
console.log("ignored close", await closed(ignored));

const mixed = spawn("cat", [], { stdio: ["ignore", "pipe", "ignore"] });
show("mixed", mixed);
mixed.stdout?.on("data", () => {});
console.log("mixed close", await closed(mixed));

const silent = fork(worker, [], { silent: true });
show("fork silent", silent);
console.log("fork silent ipc", silent.stdio[3] === null);
silent.send({});
console.log("fork silent close", await closed(silent));

const inherited = fork(worker, []);
show("fork inherited", inherited);
console.log("fork inherited ipc", inherited.stdio[3] === null);
inherited.send({});
console.log("fork inherited close", await closed(inherited));

const fromExecFile = execFile("echo", ["hi"], () => {});
show("execFile", fromExecFile);
await new Promise<void>((resolve) => fromExecFile.once("close", () => resolve()));
