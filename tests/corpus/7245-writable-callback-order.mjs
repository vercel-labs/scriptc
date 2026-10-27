// Writable callback and 'finish' timing: buffered writes completing
// inside clearBuffer keep their callback order, a deferred afterWrite
// with a user callback holds 'finish' for its own tick, a _final
// callback schedules 'finish' at once, and cork()/uncork() with
// callbacks.
import { PassThrough, Transform, Writable } from "node:stream";

function ticks(log, count) {
  let n = 0;
  const tick = () => {
    log.push("t" + n);
    if (++n < count) process.nextTick(tick);
  };
  process.nextTick(tick);
}

async function bufferedCallbacks() {
  const log = [];
  const nums = new PassThrough({ highWaterMark: 4 });
  for (let k = 0; k < 6; k++) log.push("w" + nums.write("n" + k, () => log.push("cb" + k)));
  nums.end(() => log.push("end-cb"));
  nums.on("finish", () => log.push("finish"));
  nums.on("end", () => log.push("end"));
  for await (const chunk of nums) log.push("r" + chunk.length);
  log.push("done");
  console.log("buffered:", log.join(" "));
}

function finishTiming() {
  return new Promise((resolve) => {
    const log = [];
    ticks(log, 10);
    const plain = new Writable({ write(c, e, cb) { log.push("pw" + c); cb(); } });
    plain.write("1", () => log.push("pcb1"));
    plain.write("2");
    plain.end("3", () => log.push("pend"));
    plain.on("finish", () => log.push("pfinish"));
    const withFinal = new Writable({
      write(c, e, cb) { log.push("fw" + c); cb(); },
      final(cb) { log.push("final"); cb(); },
    });
    withFinal.write("1", () => log.push("fcb1"));
    withFinal.end(() => log.push("fend"));
    withFinal.on("finish", () => log.push("ffinish"));
    const corked = new Writable({ write(c, e, cb) { log.push("cw" + c); cb(); } });
    corked.cork();
    corked.write("a", () => log.push("ccb-a"));
    corked.write("b", () => log.push("ccb-b"));
    process.nextTick(() => {
      corked.uncork();
      corked.end(() => log.push("cend"));
    });
    corked.on("finish", () => log.push("cfinish"));
    const t = new Transform({
      transform(c, e, cb) { cb(null, c); },
      flush(cb) { log.push("flush"); cb(); },
    });
    t.resume();
    t.write("q", () => log.push("tcb"));
    t.end(() => log.push("tend"));
    t.on("finish", () => log.push("tfinish"));
    t.on("end", () => log.push("tread-end"));
    setTimeout(() => {
      console.log("timing:", log.join(" "));
      resolve(undefined);
    }, 10);
  });
}

await bufferedCallbacks();
await finishTiming();
