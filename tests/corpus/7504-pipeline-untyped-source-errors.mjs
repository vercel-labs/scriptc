// pipeline() over untyped iterable sources: a destination that fails closes
// the source, backpressure waits for drain, an abort signal stops the pump,
// and async generator and Map sources reach object-mode destinations.
import { pipeline, Writable, PassThrough } from "node:stream";
import { pipeline as pipelineP } from "node:stream/promises";

function* counted(label, n) {
  try {
    for (let i = 0; i < n; i++) {
      console.log(label, "yield", i);
      yield `${label}${i}`;
    }
  } finally {
    console.log(label, "finally");
  }
}
function pick(v) {
  return v;
}

// the destination fails on its second write: the source's finally runs
await new Promise((resolve) => {
  let n = 0;
  const dst = new Writable({
    write(chunk, _e, cb) {
      n++;
      console.log("fail write", String(chunk));
      cb(n === 2 ? new Error("write failed") : null);
    },
  });
  pipeline(pick(counted("f", 5)), dst, (err) => {
    console.log("fail done", err && err.message);
    resolve();
  });
});

// backpressure: a one-byte highWaterMark and asynchronous writes
await new Promise((resolve) => {
  const dst = new Writable({
    highWaterMark: 1,
    write(chunk, _e, cb) {
      console.log("slow write", String(chunk));
      setTimeout(cb, 1);
    },
  });
  pipeline(pick(counted("b", 3)), dst, (err) => {
    console.log("slow done", err);
    resolve();
  });
});

// an abort signal
const ac = new AbortController();
try {
  await pipelineP(
    pick(counted("s", 10)),
    new Writable({
      write(chunk, _e, cb) {
        console.log("signal write", String(chunk));
        if (String(chunk) === "s1") ac.abort();
        cb();
      },
    }),
    { signal: ac.signal },
  );
} catch (err) {
  console.log("signal rejected", err.name);
}

// an untyped async generator into a PassThrough read with for await
const out = new PassThrough({ objectMode: true });
const both = pipelineP(
  pick((async function* () {
    yield "u1";
    yield "u2";
  })()),
  out,
);
for await (const c of out) console.log("passthrough", c);
await both;
console.log("passthrough resolved");

// a Map source of entries into an object-mode sink
await new Promise((resolve) => {
  pipeline(
    pick(new Map([["k", 1]])),
    new Writable({ objectMode: true, write(c, _e, cb) { console.log("map write", JSON.stringify(c)); cb(); } }),
    (err) => { console.log("map done", err); resolve(); },
  );
});
