'use strict';
// A prompt that is not a string, set from JavaScript: getPrompt() answers
// the stored value itself, a terminal interface writes the value's
// String() on every prompt and getCursorPos() measures that same text,
// and a non-terminal interface refuses to write the value. The coercion
// is the one `prompt + line` performs, so an object's valueOf runs before
// its toString and a symbol throws.
const readline = require('node:readline');
const { PassThrough, Writable } = require('node:stream');

function collector() {
  const chunks = [];
  const output = new Writable({ write(chunk, _encoding, callback) {
    chunks.push(chunk.toString());
    callback();
  } });
  return { output, text: () => chunks.join(''), clear: () => { chunks.splice(0); } };
}

const input = new PassThrough();
const out = collector();
const rl = readline.createInterface({ input, output: out.output, terminal: true });
console.log('default prompt', JSON.stringify(rl.getPrompt()));

rl.setPrompt(42);
console.log('number prompt', typeof rl.getPrompt(), rl.getPrompt());
rl.prompt();
console.log('number out', JSON.stringify(out.text()));
out.clear();

const obj = { toString() { return 'OBJ'; } };
rl.setPrompt(obj);
console.log('object identity', rl.getPrompt() === obj);
rl.prompt();
console.log('object out', JSON.stringify(out.text()));
console.log('object cursor', JSON.stringify(rl.getCursorPos()));
out.clear();

// `prompt + line` takes the default hint: valueOf before toString.
const both = { valueOf() { return 7; }, toString() { return 'T'; } };
rl.setPrompt(both);
rl.prompt();
console.log('valueOf out', JSON.stringify(out.text()));
out.clear();

// A symbol prompt throws as the concatenation does; the interface keeps
// working with a string prompt afterwards.
rl.setPrompt(Symbol('p'));
try {
  rl.getCursorPos();
} catch (err) {
  console.log('symbol cursor throws', err.name, err.message);
}
try {
  rl.prompt();
} catch (err) {
  console.log('symbol throws', err.name, err.message);
}
out.clear();
rl.setPrompt('> ');
rl.prompt();
console.log('after symbol', JSON.stringify(out.text()));
rl.close();

// A non-terminal interface validates the prompt instead of coercing it.
const plain = readline.createInterface({ input: new PassThrough() });
plain.setPrompt({ toString() { return 'P'; } });
try {
  plain.prompt();
} catch (err) {
  console.log('plain throws', err.name, err.code, err.message);
}
plain.close();
