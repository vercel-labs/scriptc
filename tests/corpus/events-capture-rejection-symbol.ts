// The events module's captureRejectionSymbol is Symbol.for('nodejs.rejection'):
// the class static, the named import and the ES module namespace answer the
// same interned symbol, and it names an event like any other symbol. The
// captureRejections option behind it is not implemented, so the default
// (false) is what these registrations observe: the symbol's listeners run
// only when the event is emitted under it.
import { EventEmitter, captureRejectionSymbol } from "node:events";
import * as events from "node:events";

const symbol = EventEmitter.captureRejectionSymbol;
console.log("shape", typeof symbol, Symbol.keyFor(symbol), symbol.description, String(symbol));
console.log("identity", symbol === Symbol.for("nodejs.rejection"));
console.log("imports", symbol === captureRejectionSymbol, events.captureRejectionSymbol === symbol);
console.log("module", events.EventEmitter === EventEmitter);

const ee = new EventEmitter();
const seen: string[] = [];
ee.on(symbol, (error: Error, where: string) => {
  seen.push(`${error.message}@${where}`);
});
console.log("emit", ee.emit(symbol, new Error("rejected"), "registration"), seen.join(","));
console.log("counts", ee.listenerCount(symbol), ee.eventNames().length);

const handler = (error: Error): void => {
  seen.push(`once:${error.message}`);
};
ee.once(symbol, handler);
console.log("once registered", ee.listenerCount(symbol));
ee.emit(EventEmitter.captureRejectionSymbol, new Error("second"), "emit");
console.log("once consumed", ee.listenerCount(symbol), seen.join(","));

ee.removeListener(symbol, handler);
console.log("removed", ee.listenerCount(symbol));
ee.emit(symbol, new Error("third"), "after remove");
console.log("after remove", seen.length);

// Registering under Symbol.for('nodejs.rejection') directly is the same event.
const direct = new EventEmitter();
let directCount = 0;
direct.on(Symbol.for("nodejs.rejection"), () => {
  directCount++;
});
direct.emit(symbol);
console.log("direct", directCount, direct.listenerCount(captureRejectionSymbol));

// A distinct registered symbol is a different event.
const other = Symbol.for("nodejs.rejection.other");
const distinct = new EventEmitter();
let distinctCount = 0;
distinct.on(other, () => {
  distinctCount++;
});
distinct.emit(symbol);
console.log("distinct", distinctCount, distinct.listenerCount(other));
