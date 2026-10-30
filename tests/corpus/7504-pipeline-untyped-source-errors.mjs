// pipeline() over untyped iterable sources: a destination that fails closes
// the source, backpressure waits for drain, an abort signal stops the pump,
// async generator and Map sources reach object-mode destinations, and a
// sync source's promise values, its final value included, are awaited.
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
    resolve(undefined);
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
    resolve(undefined);
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
    (err) => { console.log("map done", err); resolve(undefined); },
  );
});

// sync sources whose values are promises: each value is awaited, as
// for await over a sync iterator does, and a rejection closes the source
await pipelineP(
  pick([Promise.resolve("p1"), "p2", new Promise((r) => setTimeout(() => r("p3"), 1))]),
  new Writable({ write(c, _e, cb) { console.log("byte write", String(c)); cb(); } }),
);
function* promised() {
  try {
    yield Promise.resolve({ n: 1 });
    yield Promise.reject(new Error("value rejected"));
    yield "never";
  } finally {
    console.log("promised finally");
  }
}
try {
  await pipelineP(
    pick(promised()),
    new Writable({ objectMode: true, write(c, _e, cb) { console.log("object write", JSON.stringify(c)); cb(); } }),
  );
} catch (err) {
  console.log("promised rejected", err.message);
}

// a sync source's final value is awaited too: a rejected one rejects the
// pipeline, and a resolved one is not written
function* finalRejects() {
  yield "f1";
  return Promise.reject(new Error("final value rejected"));
}
function* finalResolves() {
  yield "r1";
  return Promise.resolve("not written");
}
for (const [label, source] of [["finalRejects", finalRejects], ["finalResolves", finalResolves]]) {
  try {
    await pipelineP(
      pick(source()),
      new Writable({ objectMode: true, write(c, _e, cb) { console.log(label, "write", c); cb(); } }),
    );
    console.log(label, "resolved");
  } catch (err) {
    console.log(label, "rejected", err.message);
  }
}

// the final result's value is read for a sync iterator only: an async
// iterator's done result is not read, so a throwing value getter there is
// never called
function finalResult(label, i) {
  if (i === 1) return { value: `${label}1`, done: false };
  return {
    done: true,
    get value() {
      throw new Error(`${label} final value read`);
    },
  };
}
function asyncFinal() {
  let i = 0;
  return { [Symbol.asyncIterator]() { return { async next() { i++; return finalResult("async", i); } }; } };
}
function syncFinal() {
  let i = 0;
  return { [Symbol.iterator]() { return { next() { i++; return finalResult("sync", i); } }; } };
}
async function runFinal(label, source) {
  try {
    await pipelineP(
      pick(source),
      new Writable({ objectMode: true, write(c, _e, cb) { console.log(label, "write", c); cb(); } }),
    );
    console.log(label, "resolved");
  } catch (err) {
    console.log(label, "rejected", err.message);
  }
}
await runFinal("async final", asyncFinal());
await runFinal("sync final", syncFinal());
