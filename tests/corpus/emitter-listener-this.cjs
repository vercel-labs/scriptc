// Node calls every EventEmitter listener with the emitter as `this`: plain
// and subclassed emitters, once and prepend registrations, 'error' and
// errorMonitor listeners, listeners that emit or remove through `this`, and
// stream listeners. Arrows keep the enclosing `this`.
const EventEmitter = require('events');
const { PassThrough, Readable } = require('stream');

const ee = new EventEmitter();
function remove2() { console.log('remove2 ran'); }
ee.on('quux', function () {
  console.log('quux', this === ee, typeof this);
  this.removeListener('quux', remove2);
  console.log('count', this.listenerCount('quux'));
});
ee.on('quux', remove2);
ee.emit('quux');
ee.once('o', function (a, b) { console.log('once', a, b, this === ee); });
ee.emit('o', 1, 2);
ee.emit('o', 3, 4);
ee.prependListener('p', function () { console.log('prepend', this === ee); });
ee.prependOnceListener('p', function () { console.log('prepend once', this === ee); });
ee.emit('p');
ee.on(EventEmitter.errorMonitor, function (e) { console.log('monitor', e.message, this === ee); });
ee.on('error', function (e) { console.log('error', e.message, this === ee); });
ee.emit('error', new Error('boom'));
ee.on('arrow', () => console.log('arrow', this === module.exports));
ee.emit('arrow');

// Listener values other than function expressions.
const holder = { m: function () { console.log('object method', this === ee, this === holder); } };
ee.on('m', holder.m);
ee.emit('m');
let assigned = function () { console.log('let binding', this === ee); };
ee.on('l', assigned);
ee.emit('l');
function declared(n) { console.log('declaration', n, this === ee); }
ee.on('d', declared);
ee.emit('d', 7);

// A plain call inside a listener has its own `this`.
function helper() { return this; }
ee.on('h', function () { console.log('plain call', helper() === ee, typeof helper()); });
ee.emit('h');

// Registration through `this`.
ee.on('outer', function () {
  this.on('inner', function () { console.log('inner', this === ee); });
});
ee.emit('outer');
ee.emit('inner');

// Subclasses, nested emits and two emitters.
class Emitter extends EventEmitter {
  constructor() { super(); this.tag = 'mine'; }
}
const e = new Emitter();
e.on('x', function () {
  console.log('x', this === e, this instanceof Emitter, this instanceof EventEmitter, this.tag);
});
e.emit('x');
e.on('y', function (n) {
  if (n > 0) this.emit('y', n - 1);
  console.log('y', n, this === e);
});
e.emit('y', 2);
const other = new EventEmitter();
other.on('z', function () {
  console.log('z', this === other, this === e);
  e.emit('x');
  console.log('after nested emit', this === other);
});
other.emit('z');

// A listener that throws does not leave its `this` bound.
ee.on('t', function () { throw new Error('from listener ' + (this === ee)); });
try { ee.emit('t'); } catch (err) { console.log(err.message); }
console.log('after throw', helper() === ee);

// Streams.
const p = new PassThrough();
p.on('data', function (c) { console.log('data', String(c), this === p); });
p.on('end', function () { console.log('end', this === p); });
p.write('hi');
p.end();
const r = Readable.from(['a', 'b']);
r.on('data', function (c) { console.log('readable data', c, this === r); });
r.on('close', function () { console.log('readable close', this === r); });
