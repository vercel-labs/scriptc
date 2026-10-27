// for await over a stream completes through eos: a readable-only stream
// that will emit 'close' (autoDestroy and emitClose) ends the loop after
// 'close', a duplex after 'end', interleaved with other loops' ticks.
import { PassThrough, Readable } from "node:stream";

async function interleaved(objectMode) {
  const log = [];
  let on = true;
  (async () => {
    for (let i = 0; on && i < 30; i++) {
      log.push("t" + i);
      await null;
    }
  })();
  const nums = objectMode ? new PassThrough({ objectMode: true }) : new PassThrough({ highWaterMark: 4 });
  for (let k = 0; k < 6; k++) nums.write(objectMode ? k : "n" + k);
  nums.end();
  nums.on("end", () => log.push("N-END"));
  nums.on("close", () => log.push("N-CLOSE"));
  nums.on("finish", () => log.push("N-FINISH"));
  const fr = Readable.from(["a", "b", "c"]);
  fr.on("end", () => log.push("F-END"));
  fr.on("close", () => log.push("F-CLOSE"));
  const a = (async () => {
    for await (const n of nums) log.push("n" + String(n).length);
    log.push("n-done");
  })();
  const b = (async () => {
    for await (const v of fr) log.push("f" + v);
    log.push("f-done");
  })();
  await Promise.all([a, b]);
  on = false;
  console.log(objectMode ? "object:" : "bytes:", log.join(" "));
}

async function closeBeforeDone() {
  const log = [];
  const r = new Readable({ objectMode: true, read() {} });
  r.on("end", () => log.push("end"));
  r.on("close", () => log.push("close"));
  r.push({ v: 1 });
  r.push(null);
  for await (const v of r) log.push("v" + v.v);
  log.push("done " + r.destroyed);
  const keep = new Readable({ objectMode: true, autoDestroy: false, read() {} });
  keep.on("end", () => log.push("keep end"));
  keep.on("close", () => log.push("keep close"));
  keep.push(1);
  keep.push(null);
  for await (const v of keep) log.push("k" + v);
  log.push("keep done " + keep.destroyed);
  console.log("close order:", log.join(" "));
}

await interleaved(true);
await interleaved(false);
await closeBeforeDone();
