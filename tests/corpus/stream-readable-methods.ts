// Readable's methods on a typed receiver: read() sizes and states,
// push/unshift (including the byte-mode encoding argument and the
// canPushMore answer), push after EOF, unshift(null), write-after-end
// style errors, setEncoding names and canonical readableEncoding, the
// pause/resume/isPaused answers, and pipe/unpipe/destroy returns.
import { Readable, Writable } from "node:stream";

function log(...args: unknown[]) {
  console.log(...args);
}

// read() before any push
{
  const r = new Readable({ read() {} });
  log("read-empty", r.read(), r.read(0));
}

// read(n) in byte mode
{
  const r = new Readable({ read() {} });
  r.push("abcd");
  log("read2", String(r.read(2)), r.readableLength);
  log("read-rest", String(r.read()), r.readableLength);
  log("read-null", r.read());
}

// object mode read
{
  const r = new Readable({ objectMode: true, read() {} });
  r.push({ a: 1 });
  r.push(2);
  log("obj-read", JSON.stringify(r.read()), String(r.read(5)));
  log("obj-read-null", r.read());
  r.push(null);
  log("obj-eof", r.read(), r.readableEnded);
}

// push empty string is ignored, push Buffer empty in object mode is a chunk
{
  const r = new Readable({ read() {} });
  log("push-empty-ret", r.push(""));
  log("len-after-empty", r.readableLength);
  const o = new Readable({ objectMode: true, read() {} });
  log("obj-empty-ret", o.push(""));
  log("obj-len", o.readableLength, JSON.stringify(o.read()));
}

// push after EOF
{
  const r = new Readable({ read() {} });
  r.on("error", (e: any) => log("push-after-eof", e.code, e.message));
  r.push(null);
  log("push-after-eof-ret", r.push("x"));
}

// unshift
{
  const r = new Readable({ read() {} });
  r.push("world");
  r.unshift("hello ");
  log("unshift", String(r.read()));
  r.on("error", (e: any) => log("unshift-after-eof", e.code));
  r.push(null);
  log("unshift-after-eof-ret", r.unshift("late"));
}

// unshift null
{
  const r = new Readable({ read() {} });
  try {
    r.unshift(null as any);
  } catch (e) {
    log("unshift-null", (e as any).code, (e as any).message);
  }
}

// read invalid size
{
  const r = new Readable({ read() {} });
  try {
    r.read("x" as any);
  } catch (e) {
    log("read-invalid", (e as any).code, (e as any).message);
  }
  try {
    r.read(-1 as any);
  } catch (e) {
    log("read-neg", (e as any).code, (e as any).message);
  }
}

// setEncoding invalid + mid-stream multibyte
{
  const s = new Readable({ read() {} });
  const euro = Buffer.from("€");
  s.push(euro.subarray(0, 1));
  s.push(euro.subarray(1));
  s.setEncoding("utf8");
  log("split-euro", JSON.stringify(s.read()));
}

// encodings
{
  const hex = new Readable({ read() {} });
  hex.setEncoding("hex");
  hex.push(Buffer.from("hi there"));
  log("enc-hex", JSON.stringify(hex.read()));
  const b64 = new Readable({ read() {} });
  b64.setEncoding("base64");
  b64.push(Buffer.from("hi there"));
  log("enc-base64", JSON.stringify(b64.read()));
  const lat = new Readable({ read() {} });
  lat.setEncoding("binary");
  lat.push(Buffer.from("hi there"));
  log("enc-binary-name", JSON.stringify(lat.readableEncoding));
  log("enc-binary", JSON.stringify(lat.read()));
  const u16 = new Readable({ read() {} });
  u16.setEncoding("ucs2");
  u16.push(Buffer.from("hi there"));
  log("enc-ucs2-name", JSON.stringify(u16.readableEncoding));
  log("enc-ucs2", JSON.stringify(u16.read()));
  const up = new Readable({ read() {} });
  up.setEncoding("utf8");
  up.push(Buffer.from("x"));
  log("enc-upper-name", JSON.stringify(up.readableEncoding));
}

// pause/resume/isPaused return values
{
  const r = new Readable({ read() {} });
  log("pause-ret", r.pause() === r, r.isPaused());
  log("resume-ret", r.resume() === r, r.isPaused());
}

// pipe with end:false and unpipe
{
  const r = new Readable({ read() {} });
  const w = new Writable({
    write(c, e, cb) {
      log("pipe-write", String(c));
      cb();
    },
  });
  w.on("finish", () => log("pipe-w-finish"));
  log("pipe-ret", r.pipe(w, { end: false }) === w);
  r.push("a");
  r.push(null);
  setTimeout(() => {
    log("after-end-no-finish", w.writableFinished);
    log("unpipe-ret", r.unpipe(w) === r);
  }, 20);
}

// destroy quiet / with error
setTimeout(() => {
  const r = new Readable({ read() {} });
  r.on("close", () => log("quiet-destroy-close", r.destroyed, r.closed));
  log("destroy-ret", r.destroy() === r);
  r.on("error", (e: any) => log("destroy-err", e.code));
}, 40);

setTimeout(() => {
  const r = new Readable({ read() {} });
  const err = new Error("boom");
  r.on("error", (e: any) => log("destroy-err-ev", e === err));
  r.on("close", () => log("destroy-err-close", r.errored === err));
  r.destroy(err);
  log("read-after-destroy", r.read());
}, 60);

// reading after end
setTimeout(() => {
  const r = new Readable({ read() {} });
  r.resume();
  r.on("end", () => {
    log("after-end-read", r.read(), r.readableEnded, r.readableLength);
  });
  r.push("x");
  r.push(null);
}, 80);
