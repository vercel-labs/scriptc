// spawn/spawnSync/fork stdio: the scalar modes, null and undefined entries
// (Node's default "pipe"), number output fds, and the fork's fourth "ipc"
// slot. The pinned facts are which slots are piped (child.stdin/stdout/stderr
// non-null) and what the synchronous forms capture.
import { execFileSync, fork, spawn, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";

function closed(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve) => child.once("close", (code) => resolve(code)));
}

const ignored = spawn("echo", ["hidden"], { stdio: "ignore" });
console.log("ignore", ignored.stdin === null, ignored.stdout === null, ignored.stderr === null);
console.log("ignore exit", await closed(ignored));

const inherited = spawn("true", [], { stdio: "inherit" });
console.log("inherit", inherited.stdin === null, inherited.stdout === null, inherited.stderr === null);
console.log("inherit exit", await closed(inherited));

const piped = spawn("echo", ["shown"]);
console.log("pipe", piped.stdin !== null, piped.stdout !== null, piped.stderr !== null);
piped.stdout?.on("data", (data) => console.log("pipe data", String(data).trim()));
console.log("pipe exit", await closed(piped));

const nullish = spawn("echo", ["both"], { stdio: null });
console.log("null", nullish.stdin !== null, nullish.stdout !== null, nullish.stderr !== null);
nullish.stdout?.on("data", (data) => console.log("null data", String(data).trim()));
console.log("null exit", await closed(nullish));

const undef = spawn("echo", ["both"], { stdio: undefined });
console.log("undefined", undef.stdin !== null, undef.stdout !== null, undef.stderr !== null);
undef.stdout?.on("data", (data) => console.log("undefined data", String(data).trim()));
console.log("undefined exit", await closed(undef));

const slots = spawn("echo", ["slots"], { stdio: [null, undefined, "ignore"] });
console.log("slots", slots.stdin !== null, slots.stdout !== null, slots.stderr === null);
slots.stdout?.on("data", (data) => console.log("slots data", String(data).trim()));
console.log("slots exit", await closed(slots));

const sink = openSync("/dev/null", "w");
const fdSlot = spawn("sh", ["-c", "echo to-fd"], { stdio: [null, sink, "ignore"] });
console.log("fd", fdSlot.stdin !== null, fdSlot.stdout === null, fdSlot.stderr === null);
console.log("fd exit", await closed(fdSlot));
closeSync(sink);

const syncIgnore = spawnSync("echo", ["x"], { stdio: "ignore" });
console.log("sync ignore", syncIgnore.status);
const syncDefault = spawnSync("echo", ["y"], { stdio: null });
console.log("sync null", syncDefault.status, String(syncDefault.stdout).trim());
const syncSlots = spawnSync("echo", ["z"], { stdio: [null, undefined, "ignore"] });
console.log("sync slots", syncSlots.status, String(syncSlots.stdout).trim());
console.log("sync shell", execFileSync("echo", ["through"], { stdio: "pipe" }).toString().trim());

const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
const worker = fileURLToPath(new URL(`./worker.${extension}`, import.meta.url));
const forked = fork(worker, [], { stdio: [null, null, null, "ipc"] });
console.log("fork", forked.stdin !== null, forked.stdout !== null, forked.stderr !== null);
console.log("fork exit", await closed(forked));

// A nullish scalar stdio is not an entry list: fork resolves it to its own
// default, which is inherit unless `silent` is set. (A nullish *entry*, pinned
// above, is spawn's default "pipe".)
const nullFork = fork(worker, [], { stdio: null });
console.log("fork null", nullFork.stdin === null, nullFork.stdout === null, nullFork.stderr === null);
console.log("fork null exit", await closed(nullFork));

const undefinedFork = fork(worker, [], { stdio: undefined });
console.log("fork undefined", undefinedFork.stdin === null, undefinedFork.stdout === null, undefinedFork.stderr === null);
console.log("fork undefined exit", await closed(undefinedFork));

// `silent` flips that default to pipe whatever order the two appear in.
const silentFirst = fork(worker, [], { silent: true, stdio: null });
console.log("fork silent null", silentFirst.stdin !== null, silentFirst.stdout !== null, silentFirst.stderr !== null);
console.log("fork silent null exit", await closed(silentFirst));

const nullFirst = fork(worker, [], { stdio: null, silent: true });
console.log("fork null silent", nullFirst.stdin !== null, nullFirst.stdout !== null, nullFirst.stderr !== null);
console.log("fork null silent exit", await closed(nullFirst));
