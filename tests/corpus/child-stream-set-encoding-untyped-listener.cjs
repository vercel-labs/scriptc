'use strict';
// An unannotated 'data' listener on a child stream that setEncoding
// switched to strings receives strings, as in Node's
// test-child-process-default-options: the declarations type the chunk as
// a Buffer. A stream without setEncoding keeps delivering Buffers, and a
// listener added before the setEncoding call also receives strings.
const { spawn } = require('child_process');

process.env.HELLO = 'WORLD';
const child = spawn('/usr/bin/env', [], {});
let response = '';
const kinds = new Set();
child.stdout.setEncoding('utf8');
child.stdout.on('data', function (chunk) {
  kinds.add(typeof chunk);
  response += chunk;
});

const raw = spawn('printf', ['raw bytes']);
let rawText = '';
raw.stdout.on('data', (chunk) => {
  kinds.add(Buffer.isBuffer(chunk) ? 'buffer' : typeof chunk);
  rawText += chunk.toString('utf8', 0, chunk.length);
});

const early = spawn('printf', ['early listener']);
let earlyText = '';
early.stdout.on('data', (chunk) => {
  earlyText += chunk;
  kinds.add(`early ${typeof chunk}`);
});
early.stdout.setEncoding('utf8');

process.on('exit', () => {
  console.log(response.includes('HELLO=WORLD'), JSON.stringify(rawText), JSON.stringify(earlyText));
  console.log([...kinds].sort().join(' '));
});
