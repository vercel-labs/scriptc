// Chained readline listener registration: on(), once() and addListener()
// return the interface, so `createInterface(...).on('line', f).on('close', g)`
// registers both listeners, in order, on the same interface; a chain's value
// is the interface itself.
'use strict';
const readline = require('node:readline');
const { Readable } = require('node:stream');

const lines = [];
readline
  .createInterface({ input: Readable.from(['alpha\nbeta\n', 'gamma\n']), terminal: false })
  .on('line', (line) => lines.push(line))
  .once('line', (line) => console.log('first line', line))
  .on('close', () => console.log('lines', lines.length, lines.join(',')));

const rl = readline.createInterface({ input: Readable.from(['one\ntwo']) });
const same = rl.on('line', (line) => console.log('rl line', line)).addListener('close', () => {
  console.log('rl close');
});
console.log('chain returns the interface', same === rl);

let count = 0;
readline
  .createInterface({ input: Readable.from(['x\ny\nz\n']) })
  .on('line', () => {
    count++;
  })
  .on('pause', () => console.log('pause after', count))
  .on('close', () => console.log('count', count));
