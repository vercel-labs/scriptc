// Deferred construction in JavaScript: construct in an options literal,
// in an options value read at run time, and _construct on a constructor
// function's prototype, with the write, read, error, destroy-while-
// constructing, throwing and double-callback paths.
import * as stream from "node:stream";
import { Writable, Readable } from "node:stream";
import * as util from "node:util";
const log = [];
const tick = (n) => { let i = 0; const f = () => { log.push("t" + i); if (++i < n) process.nextTick(f); }; process.nextTick(f); };
tick(4);
const wopts = {
  construct(cb) { log.push("construct"); setTimeout(() => { log.push("constructed"); cb(); }, 2); },
  write(c, e, cb) { log.push("write " + c + "/" + e); cb(); },
  final(cb) { log.push("final"); cb(); },
};
const w = new Writable(dyn(wopts));
log.push("write ret " + w.write("a"));
w.end("b");
w.on("finish", () => log.push("finish"));
w.on("close", () => { log.push("close"); next(); });
function next() {
  const ropts = { construct(cb) { log.push("r construct"); process.nextTick(cb); }, read() { log.push("read"); r.push("x"); r.push(null); } };
  const r = new Readable(dyn(ropts));
  r.on("data", (c) => log.push("data " + c));
  r.on("end", () => { log.push("r end"); errs(); });
}
function errs() {
  const eo = { construct(cb) { cb(new Error("boom")); }, write(c, e2, cb) { cb(); } };
  const e = new Writable(dyn(eo));
  e.on("error", (err) => log.push("error " + err.message));
  e.on("close", () => { log.push("e close"); destroyDuring(); });
}
function destroyDuring() {
  const dopts = { construct(cb) { setTimeout(() => cb(new Error("late")), 2); }, write(c, e, cb) { cb(); }, destroy(err, cb) { log.push("destroy " + (err && err.message)); cb(err); } };
  const d = new Writable(dyn(dopts));
  d.on("error", (err) => log.push("d error " + err.name + " " + err.message + " " + (err.errors ? err.errors.map((x) => x.message).join("+") : "")));
  d.on("close", () => { log.push("d close"); throwing(); });
  d.destroy(new Error("early"));
}
function throwing() {
  const to = { construct(cb) { throw new Error("thrown"); }, write(c, e, cb) { cb(); } };
  const t = new Writable(dyn(to));
  t.on("error", (err) => log.push("t error " + err.message));
  t.on("close", () => { log.push("t close"); twice(); });
}
function twice() {
  const o = { construct(cb) { cb(); cb(); }, write(c, e, cb) { cb(); } };
  const t = new Writable(dyn(o));
  t.on("error", (err) => log.push("twice error " + err.code));
  t.on("close", () => { log.push("twice close"); viaLiteral(); });
  setTimeout(() => t.destroy(), 5);
}
function dyn(o) {
  return o;
}
function viaLiteral() {
  const lit = new Writable({
    construct(cb) {
      log.push("literal construct " + (this === lit));
      setImmediate(cb);
    },
    write(chunk, enc, cb) {
      log.push(`literal write ${chunk}/${enc}`);
      cb();
    },
  });
  lit.end("z", () => {
    log.push("literal end");
    viaConstructor();
  });
}
function viaConstructor() {
  function Bad() {
    stream.Readable.call(this);
  }
  util.inherits(Bad, stream.Readable);
  Bad.prototype._construct = function () {
    throw new Error("ctor threw");
  };
  Bad.prototype._read = function () {};
  function Late(opts) {
    stream.Writable.call(this, opts);
  }
  util.inherits(Late, stream.Writable);
  Late.prototype._construct = function (cb) {
    log.push("late construct " + (this instanceof Late));
    setTimeout(cb, 1);
  };
  Late.prototype._write = function (chunk, enc, cb) {
    log.push("late write " + chunk);
    cb();
  };
  const late = new Late();
  late.write("q");
  late.end(() => {
    log.push("late end");
    const bad = new Bad();
    bad.on("error", (e) => log.push("bad " + e.message));
    bad.on("close", () => console.log(log.join("\n")));
  });
}
