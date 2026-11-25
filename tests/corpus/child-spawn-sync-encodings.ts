// child_process.spawnSync: the encoding option selects the capture's type
// as Node's normalizeSpawnArguments does — a Buffer encoding name makes
// stdout/stderr the decoded strings, while "buffer", null and an absent
// option keep the Buffer capture. A typed options value reads its encoding
// at the call (stdin's string input is encoded with it), and maxBuffer
// bounds the combined capture (error: ENOBUFS).
import { spawnSync } from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";

const script = "printf 'A\\377\\376B'; printf 'E\\001' 1>&2";

for (const encoding of ["latin1", "binary", "hex", "base64", "ascii", "utf16le", "utf8"] as const) {
  const r = spawnSync("/bin/sh", ["-c", script], { encoding });
  console.log(
    "sync",
    encoding,
    typeof r.stdout,
    JSON.stringify(r.stdout),
    JSON.stringify(r.stderr),
    r.status,
    r.signal,
  );
}

// No option, "buffer" and null are Node's Buffer capture.
const raw = spawnSync("/bin/sh", ["-c", script]);
console.log("raw:", Buffer.isBuffer(raw.stdout), raw.stdout.toString("hex"), raw.stderr.toString("hex"));
const named = spawnSync("/bin/sh", ["-c", script], { encoding: "buffer" });
console.log("buffer:", Buffer.isBuffer(named.stdout), named.stdout.length, named.stdout.toString("latin1"));
const nil = spawnSync("/bin/sh", ["-c", script], { encoding: null });
console.log("null:", Buffer.isBuffer(nil.stdout), nil.stdout.toString("hex"));

// A typed options value is a runtime record: its encoding decodes the
// capture per read.
const latinOpts: SpawnSyncOptionsWithStringEncoding = { encoding: "latin1", cwd: "/tmp", shell: true };
const typed = spawnSync("printf 'A\\377'", [], latinOpts);
console.log("typed:", typeof typed.stdout, JSON.stringify(typed.stdout), typed.status);
const hexOpts: SpawnSyncOptionsWithStringEncoding = { encoding: "hex", shell: true };
console.log("typed hex:", JSON.stringify(spawnSync("printf 'rk'", [], hexOpts).stdout));

// A string input is encoded with the options encoding, exactly Node's
// Buffer.from(input, encoding): latin1 writes one byte per code point, utf8
// its multi-byte form. A typed options record carries its encoding to stdin
// too.
console.log(
  "input latin1:",
  JSON.stringify(spawnSync("od", ["-An", "-tx1"], { input: "éA", encoding: "latin1" }).stdout),
);
console.log(
  "input utf8:",
  JSON.stringify(spawnSync("od", ["-An", "-tx1"], { input: "éA", encoding: "utf8" }).stdout),
);
const latinIn: SpawnSyncOptionsWithStringEncoding = { encoding: "latin1", input: "éA", shell: true };
console.log("typed input:", JSON.stringify(spawnSync("od -An -tx1", [], latinIn).stdout));

// maxBuffer: within the limit the capture is clean; past it Node kills the
// child and reports error ENOBUFS with a null status.
const within = spawnSync("/bin/sh", ["-c", "printf 0123456789"], { maxBuffer: 1024, encoding: "utf8" });
console.log("within:", JSON.stringify(within.stdout), within.status, within.error === undefined);
const over = spawnSync("/bin/sh", ["-c", "printf 0123456789; sleep 5"], { maxBuffer: 5, encoding: "utf8" });
const overErr = over.error as (Error & { code?: string }) | undefined;
console.log("over:", over.status, over.signal, overErr?.code, typeof over.stdout);
console.log("over message:", JSON.stringify(overErr?.message));

// The limit counts BYTES, not characters: three two-byte é are six bytes.
// The child sleeps past the limit so the kill always lands while it runs;
// a child that exits first would make status/signal timing-dependent.
const multiOver = spawnSync("/bin/sh", ["-c", "printf '\\303\\251\\303\\251\\303\\251'; sleep 5"], {
  maxBuffer: 5,
  encoding: "utf8",
});
const multiErr = multiOver.error as (Error & { code?: string }) | undefined;
console.log("unicode over:", multiOver.status, multiOver.signal, multiErr?.code);
const multiFit = spawnSync("/bin/sh", ["-c", "printf '\\303\\251\\303\\251'"], {
  maxBuffer: 5,
  encoding: "utf8",
});
console.log("unicode fits:", JSON.stringify(multiFit.stdout), multiFit.status, multiFit.error === undefined);

// A signal death still answers the capture decoded.
const killed = spawnSync("/bin/sh", ["-c", "printf 'B\\376'; kill -TERM $$"], { encoding: "latin1" });
console.log("killed:", JSON.stringify(killed.stdout), killed.status, killed.signal);

console.log("done");
