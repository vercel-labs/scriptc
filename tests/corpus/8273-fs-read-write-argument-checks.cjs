'use strict';
// fs.read, fs.readSync and fs.write check their arguments in Node's order
// and with Node's errors: the fd, the buffer, the offset, `length |= 0`,
// number and bigint positions, and the buffer window. A length with a
// valueOf method is converted once.
const fs = require('fs');
const path = require('path');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptc-fs-args-'));
const file = path.join(dir, 'data.txt');
fs.writeFileSync(file, 'abcdef');
const fd = fs.openSync(file, 'r+');
const noop = () => {};

function attempt(name, fn) {
  try {
    fn();
    console.log(name, 'ok');
  } catch (error) {
    console.log(name, error.name, error.code, error.message);
  }
}

attempt('read offset -1', () => fs.read(fd, Buffer.alloc(3), -1, 3, 0, noop));
attempt('read offset NaN', () => fs.read(fd, Buffer.alloc(3), NaN, 3, 0, noop));
attempt('read length -1', () => fs.read(fd, Buffer.alloc(3), 0, -1, 0, noop));
attempt('read length 4', () => fs.read(fd, Buffer.alloc(3), 0, 4, 0, noop));
attempt('read length 1.5', () => fs.read(fd, Buffer.alloc(3), 0, 1.5, 0, noop));
attempt('read length "x"', () => fs.read(fd, Buffer.alloc(3), 0, 'x', 0, noop));
attempt('read position 1.5', () => fs.read(fd, Buffer.alloc(3), 0, 3, 1.5, noop));
attempt('read position -2', () => fs.read(fd, Buffer.alloc(3), 0, 3, -2, noop));
attempt('read position ""', () => fs.read(fd, Buffer.alloc(3), 0, 3, '', noop));
attempt('read position 2n ** 63n', () => fs.read(fd, Buffer.alloc(3), 0, 3, 2n ** 63n, noop));
attempt('read position -2n', () => fs.read(fd, Buffer.alloc(3), 0, 3, -2n, noop));
attempt('read empty buffer', () => fs.read(fd, Buffer.alloc(0), 0, 1, 0, noop));
attempt('read fd true', () => fs.read(true, Buffer.alloc(3), 0, 3, 0, noop));
attempt('read buffer number', () => fs.read(fd, 3, 0, 3, 0, noop));

const read = (position) => {
  const buffer = Buffer.alloc(3);
  const count = fs.readSync(fd, buffer, 0, 3, position);
  return `${count} ${buffer.toString()}`;
};
attempt('readSync position 1n', () => console.log(read(1n)));
attempt('readSync position 0n', () => console.log(read(0n)));
attempt('readSync position 2n ** 63n', () => read(2n ** 63n));
attempt('readSync offset 4', () => fs.readSync(fd, Buffer.alloc(3), 4, 1, 0));
attempt('readSync buffer number', () => fs.readSync(fd, 3, 0, 1, 0));
attempt('readSync fd null', () => fs.readSync(null, Buffer.alloc(3), 0, 1, 0));
console.log(fs.readSync(fd, Buffer.alloc(3), 0, 0.5, 0), fs.readSync(fd, Buffer.alloc(3), 0, 2.5, 0));
let syncCalls = 0;
const syncLength = { valueOf: () => (++syncCalls === 1 ? 2 : 3) };
const syncTarget = Buffer.alloc(3);
const syncCount = fs.readSync(fd, syncTarget, 0, syncLength, 0);
console.log('readSync valueOf', syncCount, syncCalls, syncTarget.toString('utf8', 0, syncCount));

attempt('write fd null', () => fs.write(null, Buffer.alloc(1), 0, 1, noop));
attempt('write fd "1"', () => fs.write('1', 'x', noop));
attempt('write offset -1', () => fs.write(fd, Buffer.alloc(0), -1, noop));
attempt('write offset NaN', () => fs.write(fd, Buffer.from('abcd'), NaN, 4, 0, noop));
attempt('write offset 5', () => fs.write(fd, Buffer.from('abcd'), 5, noop));
attempt('write length 5', () => fs.write(fd, Buffer.from('abcd'), 0, 5, 0, noop));
attempt('write length -1', () => fs.write(fd, Buffer.alloc(0), 0, -1, noop));
attempt('write data number', () => fs.write(fd, 4, noop));
attempt('write no callback', () => fs.write(fd, Buffer.from('a'), 0, 1, 0));

fs.read(fd, Buffer.alloc(2), 0, 2, 2n, (error, count, buffer) => {
  console.log('read 2n', error, count, buffer.toString());
  fs.write(fd, Buffer.from('XY'), 0, 2, 0, (error2, written) => {
    console.log('wrote', error2, written, fs.readFileSync(file, 'utf8'));
    let calls = 0;
    const length = { valueOf: () => (++calls === 1 ? 1 : 3) };
    fs.read(fd, Buffer.alloc(3), 0, length, 0, (error3, count3, buffer3) => {
      console.log('read valueOf', error3, count3, calls, buffer3.toString('utf8', 0, count3));
      fs.closeSync(fd);
      fs.rmSync(dir, { recursive: true });
    });
  });
});
