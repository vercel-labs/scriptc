'use strict';
// The same program from a JavaScript module: the 'history' listener is a
// checked-dynamic one, and its argument is still the interface's array itself.
const readline = require('node:readline');
const { PassThrough } = require('node:stream');

const input = new PassThrough();
const rl = readline.createInterface({ input, terminal: true, history: ['kept'], historySize: 6 });
let first;
rl.on('history', (history) => {
  if (first === undefined) first = history;
  console.log('history', JSON.stringify(history), 'same', history === rl.history, 'first', first === history);
  if (history[0] === 'secret') history.shift();
});
rl.on('line', (line) =>
  console.log('line', JSON.stringify(line), JSON.stringify(rl.history), 'same', first === rl.history),
);
rl.on('close', () => console.log('close', JSON.stringify(rl.history), 'same', first === rl.history));
input.write('public\r');
input.write('secret\r');
input.write('\x1b[A');
console.log('recall', JSON.stringify(rl.line));
input.write('\r');
input.write('tail\r');
input.end('partial');
