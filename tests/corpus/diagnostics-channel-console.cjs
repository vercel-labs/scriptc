// The global console's output members publish the call's own argument array
// on console.log/info/debug/warn/error before the line is written, when the
// channel has subscribers. Every argument type crosses: objects, symbols,
// bigints, undefined, null, and a spread's elements.
'use strict';
const util = require('util');
const dc = require('diagnostics_channel');

const seen = [];
for (const name of ['console.log', 'console.info', 'console.debug', 'console.warn', 'console.error']) {
  // Snapshot inside the subscriber: Node's formatter prepends its inspect
  // options to the published array afterwards, which is not the message.
  dc.subscribe(name, (message) => seen.push([name, message.map(show)]));
}

const show = (value) => {
  if (typeof value === 'symbol') return `symbol:${String(value)}`;
  if (typeof value === 'bigint') return `bigint:${value}`;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'object') return `object:${JSON.stringify(value)}`;
  return `${typeof value}:${String(value)}`;
};

const shape = { a: 1, nested: [true, 'x'] };
console.log('plain', 1, true);
console.info(shape, undefined, null);
console.debug(Symbol.for('tag'), 2n);
console.warn(...['spread', 3]);
console.error({ list: [1, 2] }, 'tail');

// A subscriber's change to the published array reaches the printed line, as
// Node formats the same array after its subscribers ran.
dc.subscribe('console.log', (message) => {
  message.push('from-subscriber');
});
console.log('mutable');

// A subscriber can keep the published array and mutate it from inside a
// formatted value's inspect hook: the formatter reads a private copy, and the
// printed line is unaffected while the retained array shows the mutations.
let retained;
dc.subscribe('console.log', (message) => {
  retained = message;
});
const hostile = {
  [util.inspect.custom]() {
    retained.push('late');
    retained.splice(0, 1);
    return 'hostile';
  },
};
console.log('kept', hostile);
process.stdout.write('survived reentrant mutation\n');

// The capture goes through process.stdout, not a subscribed channel.
process.stdout.write(`${JSON.stringify(seen)}\n`);
