// An untyped event name converts with ToPropertyKey: an object reaches its
// own or inherited toString (then valueOf), so it keys the same listener
// table entry as the string that conversion answers, and the object's
// ToPrimitive exhaustion throws the spec's TypeError.
import { EventEmitter } from "node:events";

const em = new EventEmitter();
const custom = {
  toString() {
    return "custom";
  },
};
const hits = [];
em.on(custom, () => hits.push("a"));
console.log("registered", JSON.stringify(em.eventNames()));
console.log("emit string", em.emit("custom"), hits.join(","));
console.log("emit object", em.emit(custom), hits.join(","));

const byValueOf = {
  toString() {
    return {};
  },
  valueOf() {
    return "valueOf";
  },
};
em.on(byValueOf, () => hits.push("b"));
console.log("valueOf", em.emit("valueOf"), hits.join(","));

const throwing = {
  toString() {
    throw new TypeError("bad name");
  },
};
try {
  em.emit(throwing);
} catch (err) {
  console.log("threw", err.name, err.message);
}

const noPrimitive = {
  toString() {
    return {};
  },
  valueOf() {
    return {};
  },
};
try {
  em.on(noPrimitive, () => {});
} catch (err) {
  console.log("exhausted", err.name, err.message);
}
console.log("final", JSON.stringify(em.eventNames()), em.listenerCount("custom"));
