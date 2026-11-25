import { EventEmitter } from "node:events";

const log: string[] = [];
class Holder {
  private inner = new EventEmitter();
  get emitter(): EventEmitter {
    log.push("getter");
    return this.inner;
  }
}
const holder = new Holder();
const ee = new EventEmitter();
ee.on("a", () => log.push("a"));
console.log(holder.emitter.emit.call(ee, "a"));
