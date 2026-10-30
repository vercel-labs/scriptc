'use strict';
// fs.ReadStream and fs.WriteStream called without new construct their
// stream, as in Node.
const fs = require('fs');
const path = require('path');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptc-streams-'));
const target = path.join(dir, 'out.txt');
const writer = fs.WriteStream(target);
writer.on('finish', () => {
  const reader = fs.ReadStream(target, { encoding: 'utf8' });
  let text = '';
  reader.on('data', (chunk) => (text += chunk));
  reader.on('end', () => {
    console.log(text);
    fs.rmSync(dir, { recursive: true });
  });
});
writer.write('hello ');
writer.end('streams');
