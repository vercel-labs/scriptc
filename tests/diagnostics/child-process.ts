// child_process support boundaries: what stays rejected at LOWERING with
// specific messages. The fallback declarations type the supported surface
// exactly, so most misuse is a type error before lowering; these are the
// forms that TYPECHECK and fence per site.

import { execFile, fork, spawn } from "node:child_process";

// The default and explicit "pipe" forms use piped streams.
// Keep both adjacent to the remaining rejection cases.
const noOpts = spawn("/bin/echo");

// "inherit" and "ignore" remain process-only forms without child streams.
// All four supported modes must coexist with the fences below.
const piped = spawn("/bin/echo", [], { stdio: "pipe" });
const inherited = spawn("/bin/echo", [], { stdio: "inherit" });

// A variable options value must fence instead of being dropped.
const options: { stdio: "ignore"; detached: boolean } = { stdio: "ignore", detached: true };
spawn("true", [], options);
spawn("printf", ["unsafe"], { stdio: "ignore", shell: true });
const c = spawn("true", [], { stdio: "ignore" });

// `() => 5` IS assignable to a void-returning listener slot and now ADOPTS
// the slot's void (JS ignores the value); an ANNOTATED value-returning
// listener keeps its word and stays fenced — the registry calls listeners
// as void.
c.on("exit", (): number => 5);
// Methods have no bound-value form — call on directly.
const f = c.on;
// The callback slice accepts inline utf8/maxBuffer options, but not all of
// Node's options or the optional-callback overload family.
execFile("true");
execFile("true", [], { cwd: "/tmp" }, () => {});
const bufferLimit = 1024;
execFile("true", [], { maxBuffer: bufferLimit }, () => {});
const getEncoding = (): "utf8" => "utf8";
execFile("true", [], { encoding: getEncoding() }, () => {});
// Fork targets are part of the compiled graph and therefore must resolve at
// build time. The remaining channel is JSON-only and occupies stdio slot 3.
fork(process.argv[1]!);
const staticWorker = new URL("./child-process.ts", import.meta.url);
fork(staticWorker, [], { serialization: "advanced" });
fork(staticWorker, [], { stdio: ["ignore", "ignore", "ignore", "ignore"] });
// Keep each fence on its own statement so diagnostics remain site-specific.
// An unknown 'data' chunk takes the setEncoding state established before
// the listener registers; a setEncoding placed elsewhere leaves it unclear.
const pipedOut = piped.stdout!;
pipedOut.on("data", (chunk: unknown) => console.log(String(chunk)));
pipedOut.setEncoding("utf8");
// A setEncoding through a copy that can hold the same stream (a `let`
// binding here) leaves the state unclear as well.
let pipedErr = piped.stderr!;
pipedErr.setEncoding("utf8");
piped.stderr!.on("data", (chunk: unknown) => console.log(String(chunk)));
