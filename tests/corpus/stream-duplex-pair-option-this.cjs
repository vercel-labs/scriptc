// duplexPair builds both sides from the same options value, and Node calls
// the user's read, write, final and destroy as methods of the side that runs
// them: a body that pushes through `this` fills its own side, and one that
// destroys `this` closes only its side. The options are read as a run-time
// record, so the receiver the runtime passes is what makes this work.
'use strict';
const { duplexPair } = require('stream');

const events = [];
let a, b, c, d;
const side = (s, first, second) => (s === first ? 'first' : s === second ? 'second' : '?');
const opts = {
  read() {
    events.push(`read ${side(this, a, b)}`);
    this.push(this === a ? 'from-a' : 'from-b');
    this.push(null);
  },
  write(chunk, enc, cb) {
    events.push(`write ${side(this, a, b)} ${chunk.toString()} ${enc}`);
    cb();
  },
  final(cb) {
    events.push(`final ${side(this, a, b)}`);
    cb();
  },
};
[a, b] = duplexPair(opts);
const destroyOpts = {
  read() {
    this.push(null);
  },
  write(chunk, enc, cb) {
    events.push(`destroying write ${side(this, c, d)} ${chunk.toString()}`);
    this.destroy();
    cb();
  },
};
[c, d] = duplexPair(destroyOpts);
let closed = 0;
a.on('data', (chunk) => events.push(`a data ${chunk.toString()}`));
b.on('data', (chunk) => events.push(`b data ${chunk.toString()}`));
a.on('end', () => events.push('a end'));
b.on('end', () => events.push('b end'));
a.on('close', () => { events.push('a close'); closed++; });
b.on('close', () => { events.push('b close'); closed++; });
c.on('close', () => { events.push('c close'); closed++; });
d.on('close', () => { events.push('d close'); closed++; });
a.end('one');
b.end('two');
c.end('three');
process.on('exit', () => {
  console.log(`closed ${closed}`);
  console.log(events.join('\n'));
});
