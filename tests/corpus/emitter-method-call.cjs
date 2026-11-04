// EventEmitter.prototype's methods called with Function.prototype.call,
// which runs the method with the first argument as `this`.
const { EventEmitter, getEventListeners } = require('events');
const ee = new EventEmitter();
const other = new EventEmitter();
const log = [];

ee.on('a', function (x) { log.push(['a', x, this === ee]); });
other.on('b', function (x) { log.push(['b', x, this === other]); });

console.log(EventEmitter.prototype.emit.call(ee, 'a', 1));
console.log(other.emit.call(ee, 'a', 2));
console.log(EventEmitter.prototype.emit.call(other, 'b', 3));

EventEmitter.prototype.on.call(ee, 'c', function (v) { log.push(['c', v, this === ee]); });
console.log(ee.emit('c', 4));
console.log(ee.listenerCount('a'), ee.listenerCount('c'));
console.log(getEventListeners(ee, 'c').length);
console.log(EventEmitter.prototype.listenerCount.call(ee, 'a'));

EventEmitter.prototype.once.call(ee, 'd', function (v) { log.push(['d', v, this === ee]); });
ee.emit('d', 5);
ee.emit('d', 6);
console.log(ee.listenerCount('d'));

function named(x) { log.push(['named', x, this === ee]); }
EventEmitter.prototype.on.call(ee, 'e', named);
ee.emit('e', 7);
EventEmitter.prototype.removeListener.call(ee, 'e', named);
console.log(ee.listenerCount('e'));

// A holder that is a record entry reads without effects, so the method
// still runs typed. A holder fetched through an accessor is refused instead
// (tests/diagnostics/ee-method-call-holder-accessor.ts); the class-field
// holder is in emitter-method-call-holder.ts.
const record = { emitter: other };
console.log(record.emitter.emit.call(ee, 'a', 8));

console.log(JSON.stringify(log));
