// for await over a native stream that reaches the loop as an untyped
// value iterates it as a typed loop does, in the same tick order as Node:
// whole reads, an early return (the stream is destroyed), a break, an
// object-mode Transform and a stream error.
import { Readable, PassThrough, Transform } from "node:stream";
const log = [];
async function readAll(s, tag) {
  for await (const c of s) log.push(`${tag} ${typeof c} ${String(c)}`);
  log.push(`${tag} done`);
}
async function first(s, tag) {
  for await (const c of s) return `${tag} first ${String(c)}`;
}
async function breaks(s, tag) {
  for await (const c of s) { log.push(`${tag} got ${String(c)}`); break; }
}
async function failing(s, tag) {
  try { for await (const c of s) log.push(`${tag} ${c}`); } catch (e) { log.push(`${tag} caught ${e.message}`); }
}
let n = 0;
const ticker = () => { log.push(`tick ${n}`); if (++n < 6) process.nextTick(ticker); };
process.nextTick(ticker);
await readAll(Readable.from(["a", "b"]), "arr");
const r = Readable.from(["x", "y", "z"]);
r.on("close", () => log.push(`r close ${r.destroyed}`));
log.push(await first(r, "r"));
const pt = new PassThrough();
pt.on("close", () => log.push("pt close"));
pt.end("bytes");
await breaks(pt, "pt");
const t = new Transform({ objectMode: true, transform(c, e, cb) { cb(null, { v: c }); } });
t.end(1);
await (async (s) => { for await (const c of s) log.push(`t ${JSON.stringify(c)}`); })(t);
const bad = new Readable({ read() { this.destroy(new Error("boom")); } });
await failing(bad, "bad");
await readAll(["plain", "array"], "dyn");
await new Promise((res) => setTimeout(res, 5));
console.log(log.join("\n"));
