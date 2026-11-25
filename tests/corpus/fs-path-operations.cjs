// The path-shaped fs family in both callback and synchronous forms: open,
// close, fsync, rename, unlink, mkdir, copyFile and cp, with the errno
// shapes Node answers for the misuse each one accepts.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The scratch directory's random suffix would otherwise reach the output.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptc-paths-'));
const shown = (value) => (typeof value === 'string' ? value.split(root).join('<root>') : String(value));
const call = (fn, ...args) =>
  new Promise((resolve, reject) => {
    fn(...args, (error, value) => (error ? reject(error) : resolve(value)));
  });
const failure = (error) =>
  [error.name, error.code, error.syscall ?? '-', shown(error.path ?? '-')].join('|');
const failed = async (label, run) => {
  try {
    const value = await run();
    console.log(label, 'ok', value === undefined ? '-' : shown(value));
  } catch (error) {
    console.log(label, failure(error));
  }
};
const failedSync = (label, run) => {
  try {
    const value = run();
    console.log(label, 'ok', value === undefined ? '-' : shown(value));
  } catch (error) {
    console.log(label, failure(error));
  }
};

async function main() {
  const file = path.join(root, 'file.txt');
  const copy = path.join(root, 'copy.txt');
  const missing = path.join(root, 'missing.txt');
  try {
    // mkdir
    await failed('mkdir', () => call(fs.mkdir, path.join(root, 'one')));
    await failed('mkdir again', () => call(fs.mkdir, path.join(root, 'one')));
    await failed('mkdir recursive nested', () => call(fs.mkdir, path.join(root, 'deep', 'a', 'b'), { recursive: true }));
    console.log('mkdir recursive exists', fs.statSync(path.join(root, 'deep', 'a', 'b')).isDirectory());
    await failed('mkdir mode', () => call(fs.mkdir, path.join(root, 'mode'), 0o700));
    console.log('mkdir mode bits', (fs.statSync(path.join(root, 'mode')).mode & 0o777).toString(8));
    await failed('mkdir missing parent', () => call(fs.mkdir, path.join(root, 'none', 'child')));

    // open, close, fsync
    await failed('open missing', () => call(fs.open, missing, 'r'));
    const fd = await call(fs.open, file, 'w');
    await failed('write through open', async () => {
      fs.writeSync(fd, 'content');
      return 'written';
    });
    await failed('fsync', () => call(fs.fsync, fd));
    await failed('close', () => call(fs.close, fd));
    await failed('close again', () => call(fs.close, fd));
    await failed('fsync closed', () => call(fs.fsync, fd));
    await failed('open bad flag', () => call(fs.open, file, 'nope'));
    await failed('open bad mode', () => call(fs.open, file, 'r', 'nope'));
    await failed('open mode string', async () => {
      const handle = await call(fs.open, path.join(root, 'created.txt'), 'w', '640');
      fs.closeSync(handle);
      return (fs.statSync(path.join(root, 'created.txt')).mode & 0o777).toString(8);
    });
    await failed('open nul path', () => call(fs.open, 'a\u0000b', 'r'));

    // rename
    const renamed = path.join(root, 'renamed.txt');
    await failed('rename', () => call(fs.rename, file, renamed));
    console.log('rename content', fs.readFileSync(renamed, 'utf8'));
    await failed('rename missing', () => call(fs.rename, missing, path.join(root, 'x.txt')));
    await failed('rename onto missing dir', () => call(fs.rename, renamed, path.join(root, 'none', 'x.txt')));
    fs.renameSync(renamed, file);

    // unlink
    fs.writeFileSync(copy, 'copy');
    await failed('unlink', () => call(fs.unlink, copy));
    await failed('unlink missing', () => call(fs.unlink, copy));
    await failed('unlink directory', () => call(fs.unlink, path.join(root, 'one')));
    fs.unlinkSync(file);
    console.log('unlinked', fs.existsSync(file));

    // copyFile
    fs.writeFileSync(file, 'source bytes');
    await failed('copyFile', () => call(fs.copyFile, file, copy));
    console.log('copyFile content', fs.readFileSync(copy, 'utf8'));
    await failed('copyFile excl', () => call(fs.copyFile, file, copy, fs.constants.COPYFILE_EXCL));
    await failed('copyFile missing', () => call(fs.copyFile, missing, path.join(root, 'x')));
    await failed('copyFile onto itself', () => call(fs.copyFile, file, file));
    fs.copyFileSync(copy, path.join(root, 'sync-copy.txt'));
    console.log('copyFileSync content', fs.readFileSync(path.join(root, 'sync-copy.txt'), 'utf8'));

    // cp
    const tree = path.join(root, 'tree');
    fs.mkdirSync(path.join(tree, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(tree, 'a.txt'), 'a');
    fs.writeFileSync(path.join(tree, 'nested', 'b.txt'), 'b');
    const mirror = path.join(root, 'mirror');
    await failed('cp recursive', () => call(fs.cp, tree, mirror, { recursive: true }));
    console.log(
      'cp content',
      fs.readFileSync(path.join(mirror, 'a.txt'), 'utf8'),
      fs.readFileSync(path.join(mirror, 'nested', 'b.txt'), 'utf8'),
    );
    await failed('cp missing', () => call(fs.cp, path.join(root, 'absent'), path.join(root, 'target')));
    await failed('cp existing without force', () => call(fs.cp, tree, mirror, { recursive: true, force: false }));
    fs.cpSync(tree, path.join(root, 'sync-mirror'), { recursive: true });
    console.log('cpSync content', fs.readFileSync(path.join(root, 'sync-mirror', 'nested', 'b.txt'), 'utf8'));

    // The synchronous spellings answer the same ladders.
    failedSync('mkdirSync', () => fs.mkdirSync(path.join(root, 'one')));
    failedSync('openSync missing', () => fs.openSync(missing, 'r'));
    failedSync('openSync bad flag', () => fs.openSync(file, 'nope'));
    failedSync('renameSync missing', () => fs.renameSync(missing, path.join(root, 'x')));
    failedSync('unlinkSync missing', () => fs.unlinkSync(missing));
    failedSync('copyFileSync missing', () => fs.copyFileSync(missing, path.join(root, 'x')));
    failedSync('cpSync missing', () => fs.cpSync(path.join(root, 'absent'), path.join(root, 'x')));
    const syncFd = fs.openSync(file, 'r');
    fs.fsyncSync(syncFd);
    fs.closeSync(syncFd);
    failedSync('fsyncSync closed', () => fs.fsyncSync(syncFd));
    failedSync('closeSync closed', () => fs.closeSync(syncFd));
    console.log('done');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main();
