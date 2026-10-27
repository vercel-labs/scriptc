// A web ReadableStream as an async iterable source: Readable.from reads
// its chunks through the stream's iterator (pull-based and start-based
// sources, Uint8Array chunks in byte mode, an error from the controller,
// and an early destroy that cancels the stream), and it heads compose()
// and pipeline() like any async iterable.
import { Readable, Writable, compose, pipeline } from "node:stream";
const log = [];
let n = 0;
const pulled = new ReadableStream({
  pull(c) { n++; log.push(`pull ${n}`); if (n <= 3) c.enqueue(`p${n}`); else c.close(); },
  cancel(reason) { log.push(`cancel ${reason}`); },
});
for await (const c of Readable.from(pulled)) log.push(`got ${c}`);
const bytes = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("hi")); c.enqueue(new TextEncoder().encode("!")); c.close(); } });
const br = Readable.from(bytes, { objectMode: false });
br.on("data", (b) => log.push(`bytes ${Buffer.isBuffer(b)} ${b.toString()}`));
await new Promise((res) => br.on("end", res));
const failing = new ReadableStream({ start(c) { c.enqueue("ok"); c.error(new Error("web failed")); } });
const fr = Readable.from(failing);
fr.on("data", (c) => log.push(`failing data ${c}`));
fr.on("error", (e) => log.push(`failing error ${e.message}`));
await new Promise((res) => fr.on("close", res));
let m = 0;
const endless = new ReadableStream({
  pull(c) { c.enqueue(`e${++m}`); },
  cancel(reason) { log.push(`endless cancel ${reason === undefined ? "undefined" : reason}`); },
});
const er = Readable.from(endless);
er.once("data", (c) => { log.push(`endless ${c}`); er.destroy(); });
await new Promise((res) => er.on("close", res));
await new Promise((res) => setTimeout(res, 5));
const head = compose(new ReadableStream({ start(c) { c.enqueue("c1"); c.enqueue("c2"); c.close(); } }), async function* (s) { for await (const c of s) yield `${c}!`; });
log.push(`compose ${(await head.toArray()).join(",")}`);
await new Promise((resolve) =>
  pipeline(
    new ReadableStream({ start(c) { c.enqueue("q1"); c.enqueue("q2"); c.close(); } }),
    new Writable({ objectMode: true, write(c, e, cb) { log.push(`pipeline ${c}`); cb(); } }),
    (err) => { log.push(`pipeline callback ${err}`); resolve(undefined); },
  ),
);
console.log(log.join("\n"));
