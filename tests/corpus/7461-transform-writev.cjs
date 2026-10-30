// Constructor-function Transform and PassThrough streams with _writev:
// the prototype's _writev takes the batches, and a writev option shadows
// it with the stream as this.
'use strict';
const { Transform, PassThrough } = require('node:stream');
function T(opts) { Transform.call(this, opts); }
Object.setPrototypeOf(T.prototype, Transform.prototype);
Object.setPrototypeOf(T, Transform);
T.prototype._transform = function (chunk, enc, cb) { cb(null, 'T(' + chunk + ')'); };
T.prototype._writev = function (chunks, cb) {
  this.push('V(' + chunks.map((c) => String(c.chunk)).join('+') + ')');
  cb();
};
const t = Object.create(T.prototype);
T.call(t, {});
t.on('data', (d) => console.log('t data', String(d)));
t.on('end', () => console.log('t end'));
t.write('a');
t.cork();
t.write('b');
t.write('c');
process.nextTick(() => { t.uncork(); t.end(); });
function P(opts) { PassThrough.call(this, opts); }
Object.setPrototypeOf(P.prototype, PassThrough.prototype);
Object.setPrototypeOf(P, PassThrough);
const p = Object.create(P.prototype);
P.call(p, { writev(chunks, cb) { console.log('p writev', chunks.length, this === p); cb(); } });
p.on('data', (d) => console.log('p data', String(d)));
p.cork();
p.write('x');
p.write('y');
p.uncork();
p.write('z');
