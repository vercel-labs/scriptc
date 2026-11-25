'use strict';
// A terminal interface listens for 'resize' on its output stream and
// redraws the prompt and the line; the listener takes its place among the
// program's own 'resize' listeners in registration order, and close()
// removes it again. A non-terminal interface registers none.
const readline = require('node:readline');
const { PassThrough, Writable } = require('node:stream');

const chunks = [];
const output = new Writable({ write(chunk, _encoding, callback) {
  chunks.push(chunk.toString());
  callback();
} });
const text = () => chunks.join('');
const clear = () => { chunks.splice(0); };

output.on('resize', () => output.write('<before>'));
const input = new PassThrough();
const rl = readline.createInterface({ input, output, terminal: true, prompt: '> ' });
output.on('resize', () => output.write('<after>'));
const listener = () => output.write('<user>');
output.on('resize', listener);

console.log('count while open', output.listenerCount('resize'));
rl.prompt();
clear();
input.write('abc');
console.log('typed', JSON.stringify(text()));
clear();
output.emit('resize');
console.log('redraw', JSON.stringify(text()));
clear();
output.removeListener('resize', listener);
output.emit('resize');
console.log('removed', JSON.stringify(text()));
clear();
rl.close();
console.log('count after close', output.listenerCount('resize'));
output.emit('resize');
console.log('after close', JSON.stringify(text()));

// No terminal mode, no resize listener.
const plainOutput = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
const plain = readline.createInterface({ input: new PassThrough(), output: plainOutput });
console.log('non-terminal count', plainOutput.listenerCount('resize'));
plain.close();

// The other termination path removes it too: the input ends.
const ending = new PassThrough();
const endOutput = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
readline.createInterface({ input: ending, output: endOutput, terminal: true });
console.log('before end', endOutput.listenerCount('resize'));
ending.end();
setImmediate(() => console.log('after end', endOutput.listenerCount('resize')));
