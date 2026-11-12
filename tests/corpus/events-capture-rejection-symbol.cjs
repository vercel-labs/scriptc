// captureRejectionSymbol through a CommonJS require: the module object is
// the EventEmitter class, so require('node:events').captureRejectionSymbol,
// the class static, the destructured binding and the named export of the
// ES module namespace all read Symbol.for('nodejs.rejection').
const events = require("node:events");
const { EventEmitter, captureRejectionSymbol } = require("node:events");

const symbol = EventEmitter.captureRejectionSymbol;
console.log(typeof symbol, symbol === Symbol.for("nodejs.rejection"));
console.log(symbol === events.captureRejectionSymbol, symbol === captureRejectionSymbol);
console.log(symbol === events.EventEmitter.captureRejectionSymbol);
console.log(Symbol.keyFor(captureRejectionSymbol), captureRejectionSymbol.description);

const ee = new EventEmitter();
const seen = [];
ee.on(captureRejectionSymbol, function (error, where) {
  seen.push(`${error.message}@${where}`);
});
ee.emit(events.EventEmitter.captureRejectionSymbol, new Error("boom"), "require");
console.log(seen.join(","), ee.listenerCount(symbol));

const fn = () => {};
ee.on(symbol, fn);
ee.removeListener(captureRejectionSymbol, fn);
console.log(ee.listenerCount(symbol), ee.eventNames().length);
