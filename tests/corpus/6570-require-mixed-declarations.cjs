// A require declarator beside other declarators in one var statement, the
// shape bundlers emit for a module's top level. The require binding has no
// storage of its own, so every read resolves to the module: construction in
// a class constructor, a class expression extending it, and calls through
// the other builtin bindings of the same statement.
var EventEmitter = require("events"), util = require("util"), path = require("path"), Base = class extends EventEmitter {};

class Pool {
  constructor(size) {
    this.size = size;
    this.events = new EventEmitter;
    this.events.on("grow", (by) => {
      this.size += by;
      console.log("grow", by, util.format("%d -> %d", this.size - by, this.size));
    });
  }
}
const pool = new Pool(2);
pool.events.emit("grow", 3);
console.log("pool", pool.size, pool.events instanceof EventEmitter, pool.events.listenerCount("grow"));

var Worker = class {
  constructor(name) {
    this.name = name;
    this.bus = new Base;
    this.bus.on("done", (file) => console.log("done", this.name, path.basename(file)));
  }
};
const worker = new Worker("w1");
worker.bus.emit("done", "/tmp/out/report.txt");
console.log("worker", worker.bus instanceof Base, worker.bus instanceof EventEmitter, typeof Base);

// A builtin require in a nested block is alias plumbing too.
if (pool.size > 0) {
  var Emitter = require("node:events"), label = "nested";
}
class Relay {
  constructor() {
    this.out = new Emitter();
    this.out.once("ping", (n) => console.log(label, "ping", n));
  }
}
const relay = new Relay();
relay.out.emit("ping", 1);
relay.out.emit("ping", 2);
console.log("relay", relay.out.listenerCount("ping"), Emitter === EventEmitter);
