// listeners(), rawListeners() and getEventListeners() of events whose
// listeners include functions with untyped parameters or that read
// arguments: the array holds the registered functions in order.
const { EventEmitter, getEventListeners } = require('events');
const e = new EventEmitter();
function typed() { console.log('typed'); }
function packed() { console.log('packed', arguments.length); }
function withParam(a) { console.log('withParam', a); }
e.on('foo', typed);
e.on('foo', packed);
e.once('foo', withParam);
let fl = e.listeners('foo');
console.log(fl.length, fl[0] === typed, fl[1] === packed, fl[2] === withParam);
const raw = e.rawListeners('foo');
console.log(raw.length, raw[2] === withParam || typeof raw[2].listener === 'function');
console.log(getEventListeners(e, 'foo').length);
e.emit('foo', 1, 2);
fl = e.listeners('foo');
console.log(fl.length);
fl[0]();
fl[1](7, 8, 9);
e.off('foo', typed);
console.log(e.listeners('foo').length, e.listeners('foo')[0] === packed);
e.removeListener('foo', packed);
console.log(e.listeners('foo').length, e.listenerCount('foo'));
const g = new EventEmitter();
g.on('bar', function (x) { console.log('bar', x); });
g.on('bar', (x, y) => console.log('bar2', x, y));
g.emit('bar', 'a');
g.emit('bar', 'a', 'b', 'c');
console.log(g.listeners('bar').length, typeof g.listeners('bar')[1]);
console.log(e.listeners('nothing').length);
