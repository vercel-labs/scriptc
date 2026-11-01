// Number, null, undefined and boolean event names key the listener table by
// their property key, String(name), as in Node.
const EventEmitter = require('events');
const ee = new EventEmitter();
ee.on(123, (a) => console.log('123 got', a));
ee.emit('123', 'x');
ee.emit(123, 'y');
console.log(ee.listenerCount(123), ee.listenerCount('123'), ee.eventNames());
ee.on(null, () => console.log('null fired'));
ee.emit('null');
ee.emit(null);
ee.once(undefined, (v) => console.log('undefined fired', v));
ee.emit(undefined, 1);
ee.emit('undefined', 2);
ee.on(true, () => console.log('true fired'));
ee.emit('true');
ee.on(-1.5, () => console.log('negative fired'));
ee.emit('-1.5');
console.log(ee.eventNames());
function onNull() { console.log('second null'); }
ee.prependListener(null, onNull);
ee.emit(null);
ee.removeListener('null', onNull);
ee.emit(null);
ee.removeAllListeners(123);
console.log(ee.listenerCount(123), ee.eventNames());

// A number-literal name computed by a call is evaluated before it keys.
/** @returns {7} */
function nextName() {
  console.log('name evaluated');
  return 7;
}
ee.on(nextName(), (v) => console.log('seven', v));
console.log(ee.emit(7, 'a'));
console.log(ee.emit(nextName(), 'b'));
console.log(ee.eventNames());
