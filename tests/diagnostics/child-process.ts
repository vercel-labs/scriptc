// child_process support boundaries: what stays rejected at LOWERING with
// specific messages. The fallback declarations type the supported surface
// exactly, so most misuse is a type error before lowering; these are the
// forms that TYPECHECK and fence per site.

import {
  execFile,
  fork,
  spawn,
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";

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
// The shell forms take the complete command in the first argument; separate
// args would need Node's DEP0190 warning, which a native build cannot report.
const shellArgs = ["unsafe"];
spawn("printf", shellArgs, { stdio: "ignore", shell: true });
spawnSync("printf", ["%s", "unsafe"], { shell: true });
const c = spawn("true", [], { stdio: "ignore" });

// Value-returning listeners — inferred, annotated, or async — ADOPT the
// slot's void: Node drops whatever a listener returns, and the closure
// adapter discards it (tests/corpus/child-listener-return-values.ts).
// Methods have no bound-value form — call on directly.
const f = c.on;
// spawnSync's shell must be a literal: a runtime boolean has no value to
// check at the call, and the shell decision picks the launch shape.
const shellFlag = true;
spawnSync("true", [], { shell: shellFlag });
// Only the typed record (or an inline literal) flows to spawnSync at
// runtime: a merely structural options value cannot be read member by
// member.
const looseOptions: { shell?: boolean } = { shell: true };
spawnSync("true", [], looseOptions);
// A typed options value MAY enable the shell at run time, so its call takes
// no separate args either.
const typedOptions: SpawnSyncOptionsWithStringEncoding = { encoding: "utf8", shell: true };
spawnSync("printf %s", ["unsafe"], typedOptions);
// The callback slice accepts inline utf8/maxBuffer/cwd/shell options, but
// not all of Node's options or the optional-callback overload family.
execFile("true");
execFile("true", [], { killSignal: "SIGTERM" }, () => {});
execFile("printf", ["%s", "unsafe"], { encoding: "utf8", shell: true }, () => {});
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
