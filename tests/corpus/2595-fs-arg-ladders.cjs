// The fs argument-validation ladders: misuse of implemented-namespace fs
// APIs answers Node's exact typed errors (ERR_INVALID_ARG_TYPE /
// ERR_INVALID_ARG_VALUE / ERR_OUT_OF_RANGE) instead of fencing — exists'
// callback contract (and its REAL async answers, including the
// synchronous false for unvalidatable paths, Node's own wart), mkdtemp's
// prefix slot (the sync form running the real mkdtemp through the ladder),
// readFile/opendirSync's assertEncoding, watchFile's path/listener pair,
// createReadStream/createWriteStream's path and options.fd contracts, and
// fs.read's buffer/fd/offset/length/position ladder. The lchmod family is
// per-platform like Node itself: macOS validates (cb, path, then mode —
// octal strings, uint32 range) and non-macOS answers the not-a-function /
// ERR_METHOD_NOT_IMPLEMENTED shapes.
'use strict';
const fs = require('fs');
const os = require('os');
const { promises } = fs;
const show = (fn) => {
  try {
    const r = fn();
    console.log('ret', typeof r === 'string' ? 'string' : r);
  } catch (e) {
    console.log(`${e.name}|${e.code}|${e.message}`);
  }
};

// exists: the one throwing arm is the callback contract
show(() => fs.exists(__filename));
show(() => fs.exists());
show(() => fs.exists(__filename, {}));

// mkdtemp/mkdtempSync: prefix validation, then the real operation
show(() => fs.mkdtempSync(0, {}));
show(() => fs.mkdtempSync(null, {}));
show(() => fs.mkdtemp(true, () => {}));
const made = fs.mkdtempSync(os.tmpdir() + '/scrladder-', {});
console.log('made', typeof made, made.length > os.tmpdir().length, fs.existsSync(made));
fs.rmdirSync(made);

// readFile / opendirSync: assertEncoding before everything else
show(() => fs.readFile('bar.txt', { encoding: 'foo-8' }, () => {}));
show(() => fs.readFile('bar.txt'));
show(() => fs.opendirSync('.', { encoding: 'no' }));

// watchFile: path first, listener's function contract second
show(() => fs.watchFile('./some-file'));
show(() => fs.watchFile('./another-file', {}, 'bad listener'));
show(() => fs.watchFile(new Object(), () => {}));

// createReadStream/createWriteStream: options.fd, then the path contract
show(() => fs.createReadStream(46));
show(() => fs.createWriteStream(46));
show(() => fs.createReadStream(null, { fd: 'k' }));
show(() => fs.createWriteStream(null, { fd: 'k' }));

// fs.read: buffer, fd, offset, length, position — Node's order
show(() => fs.read(3, 4, 0, 'utf-8', () => {}));
show(() => fs.read(true, Buffer.allocUnsafe(4), 0, 4, 0, () => {}));
show(() => fs.read(3, Buffer.allocUnsafe(4), NaN, 4, 0, () => {}));
show(() => fs.read(3, Buffer.allocUnsafe(4), -1, 4, 0, () => {}));
show(() => fs.read(3, Buffer.allocUnsafe(4), 0, -1, 0, () => {}));
show(() => fs.read(3, Buffer.allocUnsafe(4), 0, 4, true, () => {}));
show(() => fs.read(3, Buffer.allocUnsafe(4), 0, 4, 0.5, () => {}));

// lchmod: per-platform, exactly like Node (macOS validates; the rest
// answer not-a-function / ERR_METHOD_NOT_IMPLEMENTED)
show(() => fs.lchmod(__filename));
show(() => fs.lchmod(__filename, {}));
show(() => fs.lchmod(false, 0o777, () => {}));
// the mode is parsed before the open, so a bad mode wins over a bad path
show(() => fs.lchmod(false, '123x', () => {}));
show(() => fs.lchmodSync(1));
show(() => fs.lchmodSync([]));
show(() => fs.lchmodSync(__filename, false));
show(() => fs.lchmodSync(__filename, '123x'));
show(() => fs.lchmodSync(__filename, -1));
show(() => fs.lchmodSync(__filename, 2 ** 32));
// exists' synchronous false for a path getValidatedPath rejects — Node
// calls back before returning
fs.exists({}, (y) => console.log('cb invalid', y));

(async () => {
  try { await promises.lchmod(__filename, {}); } catch (e) { console.log('rejected', e.code); }
  try { await promises.lchmod(__filename, -1); } catch (e) { console.log('rejected', e.code, e.message); }
  // exists' real async answers. Registering after both rejections orders
  // these against the rejections, but two in-flight threadpool stats have
  // no order relative to EACH OTHER — Node itself returns them reversed
  // about once in forty runs. Chained, so the pair is sequenced by the
  // callback rather than by which worker thread finishes first.
  fs.exists(__filename, (y) => {
    console.log('cb file', y);
    fs.exists(`${__filename}-NO`, (n) => console.log('cb missing', n));
  });
})();
console.log('sync tail');
