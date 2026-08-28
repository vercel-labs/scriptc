// The widened fallback ambient world: the Node/web surface real CLI
// sources reference TYPECHECKS under the fallback declarations (no
// @types/node needed to preflight) and every reached use without a
// lowering terminates in a clean SC2020-family diagnostic at its use
// site — the coverage report's honest blocker list, never a raw
// "Cannot find name". fetch, RequestInit, and AbortSignal lower natively.
// setInterval/clearInterval, process.on/once/off (signals and "exit"),
// the stdin events, and stdin.destroy() all LOWER now — the fences here
// are the members BEYOND the lowered slice.
const timer = setInterval(() => {}, 50);
clearInterval(timer);
process.stdin.destroy();
process.on("SIGINT", () => {});
process.once("exit", () => {});
process.off("exit", () => {});
process.stdin.setEncoding("utf8"); // stays fenced: chunks are bytes
const buf = Buffer.from("x", "utf8").reverse(); // from and fill lower; reverse fences
const enc = new TextEncoder().encode("x");
const dec = new TextDecoder().decode(enc);
const signal = AbortSignal.timeout(1000);
const res = fetch("https://example.com", { signal });
const tty = process.stdout.isTTY;
const errTty = process.stderr.isTTY;

import { accessSync, constants, mkdtempSync, readFileSync } from "node:fs";
accessSync("/bin/sh", constants.X_OK);
const tmp = mkdtempSync("/tmp/scr-");
const raw = readFileSync("/etc/hosts").toString(tty ? "hex" : "latin1"); // runtime BufferEncoding selection lowers too
// The computed encoding is now part of the static Buffer surface.
import { deflateSync, gzipSync } from "node:zlib";
const packed = deflateSync("data"); // string data: the wrap-it-first hint
const zipped = gzipSync("data"); // beyond the lowered pair: fenced
// The remaining imports continue the declared-but-not-lowered surface.
