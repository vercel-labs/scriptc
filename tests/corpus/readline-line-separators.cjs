'use strict';
// readline ends a line at LF, CR, CRLF, U+2028 (LINE SEPARATOR) and
// U+2029 (PARAGRAPH SEPARATOR), as Node's lineEnding does, also when a
// separator ends a chunk or the chunk has no CR.
const readline = require('readline');
const { Readable } = require('stream');

function collect(label, chunks) {
  const rl = readline.createInterface({ input: Readable.from(chunks), crlfDelay: Infinity });
  const lines = [];
  rl.on('line', (line) => {
    lines.push(line);
  });
  rl.on('close', () => {
    console.log(label, JSON.stringify(lines));
  });
}

collect('mixed', ['012\n345\r67\r\n89\u{2028}ABC\u{2029}DEF']);
collect('separators only', ['a\u2028b\u2029c\u2028']);
collect('split chunks', ['x\u2028', 'y', '\u2029z\n', 'w']);
collect('lf only', ['p\nq\n']);
collect('lookalike', ['\u2027\u202a end']);
