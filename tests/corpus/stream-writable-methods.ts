// Writable's surface: write(chunk[, encoding][, cb]) shifting and
// validation, the needDrain answer, write after end/destroy (the error a
// cut-off completion hands its callback), cork/uncork with _writev,
// setDefaultEncoding, end()'s argument forms, and the transform/duplex
// hooks that ride on them.
import { Writable, Duplex, Transform } from "node:stream";

function log(...args: unknown[]) {
  console.log(...args);
}
function code(e: any) {
  return e && e.code + " | " + e.message;
}

// write return values and drain
{
  const seen: string[] = [];
  const w = new Writable({
    highWaterMark: 4,
    write(c, e, cb) {
      seen.push("write:" + String(c) + ":" + e);
      cb();
    },
  });
  log("w1", w.write("ab"));
  log("w2", w.write("cd"));
  log("w3", w.write(Buffer.from("ef")));
  log("wlen", w.writableLength, w.writableNeedDrain);
  w.on("drain", () => log("drain", w.writableNeedDrain));
  w.end(() => log("end-cb", w.writableFinished, w.writableEnded));
  w.on("finish", () => log("finish", seen.join(",")));
}

// write encodings + callback args
setTimeout(() => {
  const w = new Writable({ decodeStrings: false, write(c, e, cb) { log("wenc", typeof c, String(c), e); cb(); } });
  w.write("hi", "hex");
  w.write("yo");
  w.write("zz", "utf8", (err) => log("wcb-err", err));
  w.end();
  // wenc: string 'hi' 'hex'? Node passes encoding 'hex' with decodeStrings false
}, 10);

// write null/undefined/numbers
setTimeout(() => {
  const w = new Writable({ write(c, e, cb) { cb(); } });
  const vals: unknown[] = [null, undefined, 5, true];
  for (const v of vals) {
    try {
      const r = w.write(v);
      log("write-val", String(v), r);
    } catch (e) {
      log("write-val-throw", String(v), code(e));
    }
  }
  const o = new Writable({ objectMode: true, write(c, e, cb) { log("obj-chunk", JSON.stringify(c)); cb(); } });
  for (const v of vals) {
    try {
      log("obj-write-ret", String(v), o.write(v));
    } catch (e) {
      log("obj-write-throw", String(v), code(e));
    }
  }
}, 20);

// write after end
setTimeout(() => {
  const w = new Writable({ write(c, e, cb) { cb(); } });
  w.on("error", (e: any) => log("write-after-end-error", e.code));
  w.end();
  const r = w.write("x", (err) => log("write-after-end-cb", err && (err as any).code));
  log("write-after-end-ret", r);
  try {
    w.end();
  } catch (e) {
    log("end-twice", code(e));
  }
}, 30);

// cork/uncork nesting and _writev
setTimeout(() => {
  const w = new Writable({
    write(c, e, cb) { log("cork-write", String(c)); cb(); },
    writev(chunks, cb) {
      log("cork-writev", chunks.map((x) => String(x.chunk) + "/" + x.encoding).join(","));
      cb();
    },
  });
  log("cork-ret", w.cork());
  log("corked", w.writableCorked);
  w.write("a");
  w.write("b", "utf8");
  w.cork();
  log("corked2", w.writableCorked);
  w.write(Buffer.from("c"));
  log("uncork-ret", w.uncork());
  log("corked3", w.writableCorked);
  log("uncork-ret2", w.uncork());
  log("corked4", w.writableCorked);
  w.end(() => log("cork-end"));
}, 40);

// setDefaultEncoding
setTimeout(() => {
  const w = new Writable({ write(c, e, cb) { log("sde-write", String(c), e); cb(); } });
  log("sde-ret", w.setDefaultEncoding("hex") === w);
  w.write("6869");
  try {
    w.setDefaultEncoding("nope");
  } catch (e) {
    log("sde-bad", code(e));
  }
  try {
    w.setDefaultEncoding(5 as any);
  } catch (e) {
    log("sde-num", code(e));
  }
  w.end();
}, 50);

// destroy
setTimeout(() => {
  const w = new Writable({ write(c, e, cb) { cb(); } });
  w.on("close", () => log("wd-close", w.destroyed, w.closed));
  log("wd-ret", w.destroy() === w);
  const err = new Error("boom");
  const w2 = new Writable({ write(c, e, cb) { cb(); } });
  w2.on("error", (e: any) => log("wd-err", e === err));
  w2.on("close", () => log("wd-close2", w2.errored === err));
  w2.destroy(err);
  log("wd-write-after-destroy", w2.write("x"));
  w2.write("y", (e) => log("wd-write-cb", e && (e as any).code));
}, 60);

// _write callback error and _final
setTimeout(() => {
  const w = new Writable({
    write(c, e, cb) { cb(); },
    final(cb) { log("final-called"); cb(new Error("final-fail")); },
  });
  w.on("error", (e: any) => log("final-error", e.message));
  w.on("finish", () => log("final-finish"));
  w.on("close", () => log("final-close"));
  w.end("x");
}, 70);

// end() argument forms
setTimeout(() => {
  const forms: [string, (w: Writable) => void][] = [
    ["none", (w) => w.end()],
    ["chunk", (w) => w.end("a")],
    ["chunk-enc", (w) => w.end("61", "hex")],
    ["cb", (w) => w.end(() => log("form-cb"))],
    ["chunk-cb", (w) => w.end("b", () => log("form-chunk-cb"))],
    ["chunk-enc-cb", (w) => w.end("62", "hex", () => log("form-chunk-enc-cb"))],
  ];
  let i = 0;
  for (const [name, fn] of forms) {
    const w = new Writable({ write(c, e, cb) { log("form-write", name, String(c), e); cb(); } });
    w.on("finish", () => log("form-finish", name));
    fn(w);
    i++;
  }
  log("forms", i);
}, 80);

// transform hooks order + flush data
setTimeout(() => {
  const t = new Transform({
    transform(c, e, cb) {
      log("tr", String(c), e);
      cb(null, String(c).toUpperCase());
    },
    flush(cb) {
      log("tr-flush");
      cb(null, "tail");
    },
  });
  t.on("data", (d) => log("tr-data", String(d)));
  t.on("end", () => log("tr-end"));
  t.on("finish", () => log("tr-finish"));
  t.end("abc");
}, 90);

// transform callback with error
setTimeout(() => {
  const t = new Transform({
    transform(c, e, cb) { cb(new Error("tr-fail")); },
  });
  t.on("error", (e: any) => log("tr-err", e.message));
  t.on("close", () => log("tr-close", t.destroyed));
  t.end("abc");
}, 100);

// transform double callback
setTimeout(() => {
  const t = new Transform({
    transform(c, e, cb) { cb(null, "a"); cb(null, "b"); },
  });
  t.on("error", (e: any) => log("tr-double", e.code));
  t.resume();
  t.end("abc");
}, 110);

// _construct ordering, _destroy
setTimeout(() => {
  const w = new Writable({
    construct(cb) {
      log("construct-called");
      setTimeout(() => { log("construct-done"); cb(); }, 5);
    },
    write(c, e, cb) { log("construct-write", String(c)); cb(); },
    destroy(err, cb) { log("destroy-hook", err && err.message); cb(err); },
  });
  w.on("finish", () => log("construct-finish"));
  w.on("close", () => log("construct-close"));
  w.write("x");
  w.end();
}, 120);

// allowHalfOpen duplex. The delay leaves the preceding block's nested 5 ms
// timer a wide margin: a loaded runner can delay a timer by more than the
// 10 ms that had separated these two blocks, which reorders their lines in
// Node itself.
setTimeout(() => {
  const d = new Duplex({
    read() { this.push(null); },
    write(c: any, e: any, cb: any) { cb(); },
    allowHalfOpen: false,
  });
  d.on("end", () => log("aho-end"));
  d.on("finish", () => log("aho-finish"));
  d.on("close", () => log("aho-close"));
  d.resume();
  d.end();
}, 250);
