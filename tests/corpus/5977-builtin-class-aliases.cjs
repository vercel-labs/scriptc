// Builtin classes through const aliases in a CommonJS file. A copy of a
// name (or of a globalThis property) keeps its value, so it can be stored
// and compared; construction, instanceof, typeof and .name resolve to the
// class. Builtin module members construct through the alias.
const { EventEmitter } = require("node:events");
const events = require("node:events");
const zlib = require("node:zlib");
const { PassThrough } = require("node:stream");

const Emitter = EventEmitter;
const NsEmitter = events.EventEmitter;
const Gz = zlib.Gzip;
const Gz2 = Gz;
const M = Map;
const GlobalSet = globalThis.Set;
const Pass = PassThrough;
const TE = TypeError;

const e = new Emitter();
e.on("ping", (n) => console.log("ping", n));
e.emit("ping", 2);
console.log("emitter", e instanceof Emitter, e instanceof NsEmitter, e instanceof EventEmitter);

const m = new M();
m.set("k", 1);
const s = new GlobalSet(["a", "b", "a"]);
console.log("collections", m.get("k"), s.size, m instanceof M, s instanceof GlobalSet, m instanceof GlobalSet);

const gz = new Gz2();
console.log("zlib", gz instanceof Gz, gz instanceof zlib.Gunzip, Gz2 === zlib.Gzip);

const pass = new Pass();
console.log("stream", pass instanceof Pass, pass instanceof EventEmitter);

try {
  throw new TE("typed");
} catch (err) {
  console.log("error", err instanceof TE, err.message);
}

const stored = [Emitter, M, GlobalSet, Pass];
console.log("stored", stored.length, stored[0] === EventEmitter, stored[1] === Map, stored[2] === Set);
console.log("typeof", typeof Emitter, typeof NsEmitter, typeof Gz2, typeof M, typeof GlobalSet, typeof TE);
console.log("name", Emitter.name, NsEmitter.name, Gz2.name, M.name, GlobalSet.name, Pass.name, TE.name);
console.log("identity", Emitter === NsEmitter, M === Map, GlobalSet === Set, M === GlobalSet);
