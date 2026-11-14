// fs.mkdtempDisposableSync / fs.promises.mkdtempDisposable argument ladders:
// Node's getOptions (the options shape, then assertEncoding) runs before
// getValidatedPath's 'prefix' slot, the reported path is the binding's result
// in the requested encoding ('buffer' rejects into path.resolve's paths[1]
// error after the directory exists), and both records' remove() deletes the
// tree from the path resolved at creation, not from a later cwd.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

// Every directory the ladders create lives under one root, so the cases
// whose directory Node cannot name (the 'buffer' encoding throws after
// creation) are cleaned up with it.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mkdtemp-disposable-arg-'));
const base = path.join(root, 'pre-');

const describe = (error) =>
  [error.name, JSON.stringify(error.code), JSON.stringify(error.message.replace(/pre-[^']*'/, "pre-…'"))].join(' ');
const attempt = (label, run) => {
  try {
    console.log(label, 'returned', run());
  } catch (error) {
    console.log(label, describe(error));
  }
};
const rejected = async (label, promise) => {
  try {
    await promise;
    console.log(label, 'fulfilled');
  } catch (error) {
    console.log(label, describe(error));
  }
};

// ── the prefix slot ────────────────────────────────────────────────────
attempt('number prefix', () => fs.mkdtempDisposableSync(42));
attempt('boolean prefix', () => fs.mkdtempDisposableSync(false));
attempt('object prefix', () => fs.mkdtempDisposableSync({}));
attempt('missing parent', () => fs.mkdtempDisposableSync('/nonexistent-mkdtemp-dir-xyz/pre-'));
const fromBuffer = fs.mkdtempDisposableSync(Buffer.from(base));
console.log('buffer prefix', typeof fromBuffer.path, fs.existsSync(fromBuffer.path));
fromBuffer.remove();
const fromUrl = fs.mkdtempDisposableSync(pathToFileURL(base));
console.log('url prefix', typeof fromUrl.path, fs.existsSync(fromUrl.path));
fromUrl.remove();

// ── the options slot ───────────────────────────────────────────────────
attempt('options number', () => fs.mkdtempDisposableSync(base, 5));
attempt('options boolean', () => fs.mkdtempDisposableSync(base, true));
attempt('options bad encoding', () => fs.mkdtempDisposableSync(base, 'bogus'));
attempt('encoding number', () => fs.mkdtempDisposableSync(base, { encoding: 5 }));
attempt('encoding buffer', () => fs.mkdtempDisposableSync(base, 'buffer'));
attempt('encoding buffer object', () => fs.mkdtempDisposableSync(base, { encoding: 'buffer' }));

const hex = fs.mkdtempDisposableSync(base, 'hex');
const decoded = Buffer.from(hex.path, 'hex').toString('utf8');
console.log('hex path', hex.path.startsWith(Buffer.from(base, 'utf8').toString('hex')), decoded.startsWith(base), fs.existsSync(decoded));
// Node stashes path.resolve(cwd, <the hex path>), so remove() targets a name
// that never existed and the directory stays: Node's own behaviour.
hex.remove();
console.log('hex still there', fs.existsSync(decoded));
fs.rmSync(decoded, { recursive: true, force: true });

const b64 = fs.mkdtempDisposableSync(base, { encoding: 'base64' });
const decodedB64 = Buffer.from(b64.path, 'base64').toString('utf8');
console.log('base64 path', decodedB64.startsWith(base), fs.existsSync(decodedB64));
b64.remove();

for (const options of [undefined, null, 'utf8', 'utf-8', '', { encoding: null }, { encoding: '' }, { encoding: false }]) {
  const dir = fs.mkdtempDisposableSync(base, options);
  console.log('default encoding', typeof dir.path, dir.path.startsWith(base), fs.existsSync(dir.path));
  dir.remove();
}

// ── the record ─────────────────────────────────────────────────────────
const record = fs.mkdtempDisposableSync(base);
console.log('sync keys', Object.keys(record).join(), Object.getPrototypeOf(record) === Object.prototype);
console.log('sync remove', record.remove.name, record.remove.length, record.remove === record[Symbol.dispose]);
console.log('sync dispose only', record[Symbol.asyncDispose]);
record.remove();
console.log('sync remove value', fs.existsSync(record.path));
record.remove();
console.log('sync remove again', fs.existsSync(record.path));
const dispose = record[Symbol.dispose];
dispose();
console.log('sync detached dispose', fs.existsSync(record.path));

// ── process.chdir after creation ───────────────────────────────────────
const away = fs.mkdtempSync(path.join(os.tmpdir(), 'mkdtemp-disposable-cwd-'));
const cwd = process.cwd();
process.chdir(away);
const relative = fs.mkdtempDisposableSync('rel-');
console.log('relative path', relative.path.startsWith(base), path.isAbsolute(relative.path), fs.existsSync(relative.path));
fs.writeFileSync(path.join(relative.path, 'entry'), 'payload');
process.chdir(os.tmpdir());
relative.remove();
console.log('relative removed', fs.existsSync(path.join(away, relative.path)));
process.chdir(cwd);
fs.rmSync(away, { recursive: true, force: true });

// ── the promise form ───────────────────────────────────────────────────
(async () => {
  await rejected('async number prefix', fsp.mkdtempDisposable(42));
  await rejected('async missing parent', fsp.mkdtempDisposable('/nonexistent-mkdtemp-dir-xyz/pre-'));
  await rejected('async bad encoding', fsp.mkdtempDisposable(base, 'bogus'));
  await rejected('async buffer encoding', fsp.mkdtempDisposable(base, 'buffer'));
  await rejected('async encoding buffer object', fsp.mkdtempDisposable(base, { encoding: 'buffer' }));

  const asyncBuffer = await fsp.mkdtempDisposable(Buffer.from(base));
  console.log('async buffer prefix', typeof asyncBuffer.path, fs.existsSync(asyncBuffer.path));
  await asyncBuffer.remove();

  const dir = await fsp.mkdtempDisposable(base);
  console.log('async keys', Object.keys(dir).join(), Object.getPrototypeOf(dir) === null);
  console.log('async remove', dir.remove.name, dir.remove.length, dir.remove === dir[Symbol.asyncDispose]);
  console.log('async dispose only', dir[Symbol.dispose]);
  fs.writeFileSync(path.join(dir.path, 'entry'), 'payload');
  console.log('async remove value', await dir.remove(), fs.existsSync(dir.path));
  console.log('async remove again', await dir.remove(), fs.existsSync(dir.path));
  const other = await fsp.mkdtempDisposable(base, 'utf8');
  console.log('async dispose value', await other[Symbol.asyncDispose](), fs.existsSync(other.path));

  fs.rmSync(root, { recursive: true, force: true });
  console.log('root removed', !fs.existsSync(root));
})();
