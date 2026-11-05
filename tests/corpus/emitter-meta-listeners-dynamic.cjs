// Checked-dynamic 'newListener' and 'removeListener' listeners receive the
// event name and the added or removed listener function.
const EventEmitter = require('events');
function listener1() {}
function listener2(a) { console.log('l2', a); }
const ee = new EventEmitter();
ee.on('newListener', function (name, fn) {
  console.log('new', name, fn === listener1, fn === listener2, typeof fn);
});
ee.on('hello', listener1);
ee.on('hello', listener2);
ee.on('removeListener', (name, cb) => {
  console.log('removed', name, cb === listener1, cb === listener2);
});
ee.removeListener('hello', listener1);
ee.emit('hello', 5);
console.log(ee.listeners('hello').length, ee.listeners('hello')[0] === listener2);
ee.removeAllListeners('hello');
console.log(ee.listenerCount('hello'));
const other = new EventEmitter();
other.once('removeListener', (name, cb) => console.log('once-removed', name, typeof cb));
other.on('x', (n) => console.log('x', n));
other.emit('x', 1);
other.removeAllListeners();
console.log(other.eventNames());

// A meta listener produced by a wrapper factory, as test helpers do.
function wrap(fn) {
  return function () {
    return fn.apply(this, arguments);
  };
}
function plain() {}
const wrapped = new EventEmitter();
wrapped.on('ping', plain);
wrapped.on('removeListener', wrap((name, cb) => console.log('wrapped removed', name, cb === plain)));
wrapped.removeListener('ping', plain);
