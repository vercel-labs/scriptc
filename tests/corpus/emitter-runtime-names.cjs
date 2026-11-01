// Event names known only at run time: listeners registered and emitted under
// them share the listener table with literal names, as in Node.
const EventEmitter = require('events');
const ee = new EventEmitter();
const names = ['alpha', 'beta'];
for (const n of names) ee.on(n, (v) => console.log('runtime listener', n, v));
ee.on('alpha', (v) => console.log('literal listener alpha', v));
ee.emit('alpha', 1);
for (const n of names) ee.emit(n, 2);
console.log(ee.eventNames(), ee.listenerCount(names[0]));
console.log(ee.listeners(names[1]).length);
function onBeta(v) { console.log('onBeta', v); }
const which = names[1];
ee.prependOnceListener(which, onBeta);
ee.emit(which, 3);
ee.emit(which, 4);
ee.off(which, onBeta);
ee.removeAllListeners(which);
console.log(ee.eventNames());
for (let i = 0; i < 3; i++) ee.on(i, () => console.log('index', i));
for (let i = 2; i >= 0; i--) ee.emit(String(i));
ee.emit(1);
console.log(ee.eventNames());
// 'error' and the meta events keep Node's behavior under runtime names.
const errorName = ['error'][0];
try {
  ee.emit(errorName, new Error('runtime error name'));
} catch (err) {
  console.log('thrown', err.message);
}
try {
  ee.emit(errorName, 'not an error');
} catch (err) {
  console.log('thrown', err.code, err.message);
}
ee.on(errorName, (e) => console.log('error listener', e.message));
ee.emit('error', new Error('caught'));
const metaName = ['newListener'][0];
ee.on(metaName, (name) => console.log('newListener', name));
ee.on('gamma', () => {});
let count = 0;
const dynamicName = 'evt' + String(count);
ee.on(dynamicName, function (a, b) { console.log('dynamic', a, b); });
console.log(ee.emit(dynamicName, 'a', 'b'), ee.emit('missing' + count));
