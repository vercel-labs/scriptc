// An event name whose static type is a string literal but whose read runs
// program code (a getter or a call) is evaluated, so its effects happen where
// Node evaluates them: at registration, emit, listenerCount and
// removeAllListeners.
import { EventEmitter } from "node:events";

const log: (string | number)[][] = [];
const ee = new EventEmitter();

class Holder {
  get name(): "a" {
    log.push(["getter"]);
    return "a";
  }
}
const holder = new Holder();

ee.on(holder.name, function (v: number) {
  log.push(["a", v]);
});
console.log(ee.listenerCount(holder.name));
console.log(ee.emit(holder.name, 1));
console.log(ee.eventNames());

function eventName(): "b" {
  log.push(["call"]);
  return "b";
}
ee.on(eventName(), function (v: string) {
  log.push(["b", v]);
});
console.log(ee.listenerCount(eventName()));
console.log(ee.emit(eventName(), "x"));
console.log(ee.removeAllListeners(eventName()) === ee);
console.log(ee.listenerCount("b"));

// An evaluated name reaches a listener a literal name registered with a
// typed tuple.
function thirdName(): "c" {
  log.push(["call c"]);
  return "c";
}
const typed = new EventEmitter();
typed.on("c", (v: number) => log.push(["c", v]));
console.log(typed.emit(thirdName(), 3));
console.log(typed.listenerCount("c"));
console.log(JSON.stringify(log));
