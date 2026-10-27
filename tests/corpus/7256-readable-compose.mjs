// readable.compose(stage, { signal }): compose(this, stage), with the
// signal aborting the composed Duplex. The stage may be an async
// generator function or a stream; the result reads like the stage's
// output and is not writable when the receiver heads it.
import { PassThrough, Readable, Transform } from "node:stream";

const log = [];

const WORDS = ["alpha", "beta", "gamma"];
const lengths = async function* (source) {
  for await (const w of source) yield `${w}:${w.length}`;
};

const source = Readable.from(WORDS);
const viaFn = source.compose(lengths);
log.push(`fn r=${viaFn.readable} w=${viaFn.writable} ro=${viaFn.readableObjectMode}`);
for await (const s of viaFn) log.push(`fn ${s}`);

const shout = new Transform({
  objectMode: true,
  transform(chunk, _enc, cb) {
    cb(null, chunk.toUpperCase());
  },
});
const source2 = Readable.from(WORDS);
const viaStream = source2.compose(shout);
log.push(`stream ${(await viaStream.toArray()).join(",")}`);

const pass = new PassThrough({ objectMode: true });
const chained = pass.compose(lengths).compose(async function* (source) {
  for await (const s of source) yield `[${s}]`;
});
chained.on("data", (s) => log.push(`chained ${s}`));
pass.write("x");
pass.end("yz");
await new Promise((resolve) => chained.on("end", resolve));

const ac = new AbortController();
const signal = ac.signal;
const slow = new Readable({ objectMode: true, read() {} });
const aborted = slow.compose(lengths, { signal });
aborted.on("data", (s) => log.push(`aborted data ${s}`));
aborted.on("error", (e) => log.push(`aborted error ${e.name} ${e.code}`));
aborted.on("close", () => log.push(`aborted close ${aborted.destroyed}`));
slow.push("one");
setTimeout(() => ac.abort(), 10);
await new Promise((resolve) => aborted.on("close", resolve));

const source3 = Readable.from(WORDS);
const unsignaled = source3.compose(lengths, undefined);
log.push(`undefined options ${(await unsignaled.toArray()).length}`);

console.log(log.join("\n"));
