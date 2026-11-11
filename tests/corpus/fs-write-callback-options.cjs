// fs.writeFile and fs.appendFile: Node's option normalization, data check,
// descriptor form and abort semantics, with the callback each case produces.
// The events array is printed in order after the last callback settles.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const shown = (error) => `${error.name}|${error.code}|${error.message}`;
const events = [];
const log = (...parts) => events.push(parts.join(' '));
function attempt(label, run) {
  try {
    const value = run();
    log(label, 'returned', String(value));
  } catch (error) {
    log(label, 'threw', shown(error));
  }
}
const writeCallback = (label) => (error) => log(label, 'callback', error ? shown(error) : 'null');
const write = (file, data, options) =>
  new Promise((resolve) => {
    const callback = (error) => {
      log('write', error ? shown(error) : 'null');
      resolve(undefined);
    };
    if (options === undefined) fs.writeFile(file, data, callback);
    else fs.writeFile(file, data, options, callback);
  });

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptc-write-cb-'));
  const file = path.join(directory, 'data.txt');
  try {
    fs.writeFileSync(file, '');
    fs.chmodSync(file, 0o600);

    // The value ladder runs before the callback ever sees an error.
    attempt('options number', () => fs.writeFile(file, 'x', 42, writeCallback('options number')));
    attempt('options boolean', () => fs.writeFile(file, 'x', true, writeCallback('options boolean')));
    // Any object is a record with no keys of its own: typeof is the test.
    attempt('options promise', () => fs.writeFile(file, 'x', new Promise(() => {}), writeCallback('options promise')));
    attempt('options array', () => fs.writeFile(file, 'x', [null], writeCallback('options array')));
    attempt('options string name', () => fs.writeFile(file, 'x', 'zzz', writeCallback('string name')));
    attempt('options string buffer', () => fs.writeFile(file, 'x', 'buffer', writeCallback('string buffer')));
    attempt('flush number', () => fs.writeFile(file, 'x', { flush: 1 }, writeCallback('flush number')));
    attempt('flush string', () => fs.writeFile(file, 'x', { flush: 'no' }, writeCallback('flush string')));
    attempt('encoding name', () => fs.writeFile(file, 'x', { encoding: 'zzz' }, writeCallback('encoding name')));
    attempt('encoding null', () => fs.writeFile(file, 'x', { encoding: null }, writeCallback('encoding null')));
    attempt('signal number', () => fs.writeFile(file, 'x', { signal: 7 }, writeCallback('signal number')));
    attempt('data number', () => fs.writeFile(file, 42, writeCallback('data number')));
    attempt('data object', () => fs.writeFile(file, {}, writeCallback('data object')));
    attempt('data null', () => fs.writeFile(file, null, writeCallback('data null')));
    attempt('data array', () => fs.writeFile(file, [1, 2], writeCallback('data array')));
    attempt('path nul', () => fs.writeFile('a\u0000b', 'x', writeCallback('path nul')));
    attempt('path number', () => fs.writeFile(1.5, 'x', writeCallback('path number')));
    attempt('path object', () => fs.writeFile({}, 'x', writeCallback('path object')));
    attempt('fd negative', () => fs.writeFile(-1, 'x', writeCallback('fd negative')));
    attempt('callback missing', () => fs.writeFile(file, 'x'));
    attempt('append encoding buffer', () =>
      fs.appendFile(file, 'x', 'buffer', writeCallback('append buffer')),
    );
    attempt('append flush number', () =>
      fs.appendFile(file, 'x', { flush: 1 }, writeCallback('append flush')),
    );

    // The flag and mode ladder throws out of the call, before the callback:
    // the async open reads the mode first, then the flags.
    attempt('bad flag', () => fs.writeFile(file, 'x', { flag: 'zz' }, writeCallback('bad flag cb')));
    attempt('bad mode', () => fs.writeFile(file, 'x', { mode: 'zzz' }, writeCallback('bad mode cb')));
    attempt('bad mode before flag', () =>
      fs.writeFile(file, 'x', { mode: 'zzz', flag: 'zz' }, writeCallback('both bad cb')),
    );
    attempt('missing path before mode', () =>
      fs.writeFile(
        path.join(directory, 'missing', 'x'),
        'x',
        { mode: 'zzz' },
        writeCallback('missing path cb'),
      ),
    );

    // Successful writes: the flag decides truncation, the encoding the bytes.
    await write(file, 'one');
    await new Promise((resolve) => {
      fs.appendFile(file, 'two', (error) => {
        log('append default', error ? shown(error) : 'null', fs.readFileSync(file, 'utf8'));
        resolve(undefined);
      });
    });
    await new Promise((resolve) => {
      fs.writeFile(file, 'é', 'latin1', (error) => {
        log('latin1 options', error ? shown(error) : 'null', fs.readFileSync(file, 'latin1'));
        resolve(undefined);
      });
    });
    await new Promise((resolve) => {
      fs.writeFile(file, 'é', { encoding: 'utf16le' }, (error) => {
        log('utf16le options', error ? shown(error) : 'null', fs.readFileSync(file).toString('hex'));
        resolve(undefined);
      });
    });
    await new Promise((resolve) => {
      fs.writeFile(file, Buffer.from('bytes'), { encoding: 'buffer' }, (error) => {
        log('buffer encoding with bytes', error ? shown(error) : 'null', fs.readFileSync(file, 'utf8'));
        resolve(undefined);
      });
    });
    await new Promise((resolve) => {
      fs.writeFile(file, 'kept', { flag: 'a' }, (error) => {
        log('flag a appends', error ? shown(error) : 'null', fs.readFileSync(file, 'utf8'));
        resolve(undefined);
      });
    });
    await new Promise((resolve) => {
      fs.writeFile(file, '', { flag: 'wx' }, (error) => {
        log('flag wx on existing', error ? error.code : 'null');
        resolve(undefined);
      });
    });
    const created = path.join(directory, 'created.txt');
    attempt('leading zero mode', () =>
      fs.writeFile(created, 'created', { mode: '0o640', flush: true }, writeCallback('leading zero cb')),
    );
    await new Promise((resolve) => {
      fs.writeFile(created, 'created', { mode: '640', flush: true }, (error) => {
        log('octal mode with flush', error ? shown(error) : 'null', fs.statSync(created).mode & 0o777);
        resolve(undefined);
      });
    });

    // The descriptor form writes at the current offset, closes nothing and
    // never parses the flag or the mode.
    const fd = fs.openSync(file, 'r+');
    await new Promise((resolve) => {
      fs.writeFile(fd, 'AB', { flag: 'zz', mode: 'zzz', flush: true }, (error) => {
        log('descriptor write', error ? shown(error) : 'null', fs.readFileSync(file, 'utf8'));
        resolve(undefined);
      });
    });
    fs.writeSync(fd, 'CD');
    fs.closeSync(fd);
    log('descriptor still open', fs.readFileSync(file, 'utf8'));

    // An aborted signal runs the callback synchronously, before the call
    // returns, and leaves the file alone.
    const controller = new AbortController();
    controller.abort(new Error('halt'));
    let aborted = 'not called';
    attempt('aborted path', () =>
      fs.writeFile(created, 'never', { signal: controller.signal }, (error) => {
        aborted = `${error.name}|${error.code}|${error.message}|${error.cause && error.cause.message}`;
      }),
    );
    log('aborted synchronous', aborted, fs.readFileSync(created, 'utf8'));
    attempt('aborted invalid data', () =>
      fs.writeFile(created, 42, { signal: controller.signal }, writeCallback('aborted data')),
    );
    attempt('aborted invalid encoding', () =>
      fs.writeFile(created, 'x', { signal: controller.signal, encoding: 'zzz' }, writeCallback('aborted encoding')),
    );
    const openController = new AbortController();
    openController.abort();
    const fd2 = fs.openSync(created, 'r+');
    let abortedFd = 'not called';
    attempt('aborted descriptor', () =>
      fs.writeFile(fd2, 'ignored', { signal: openController.signal }, (error) => {
        abortedFd = error.code;
      }),
    );
    fs.closeSync(fd2);
    log('aborted descriptor synchronous', abortedFd, fs.readFileSync(created, 'utf8'));

    // Hand the remaining callbacks a turn, then print everything in order.
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const event of events) console.log(event);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main();
