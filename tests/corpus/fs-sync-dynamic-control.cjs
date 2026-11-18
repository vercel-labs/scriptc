// The descriptor controls whose arguments a JavaScript caller leaves
// untyped: closeSync, fsyncSync, fdatasyncSync, ftruncateSync, fchmodSync,
// fchownSync and futimesSync validate and act at run time (the mode and the
// owner ids before the descriptor, the truncate length before it), and the
// readvSync/writevSync vectors take their ArrayBufferView[] check, empty
// early return and position rule at run time too.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = path.join(os.tmpdir(), `scr-dyn-ctl-${process.pid}.txt`);
fs.writeFileSync(scratch, '0123456789');

const show = (label, fn) => {
  try {
    console.log(label, 'ret', fn());
  } catch (e) {
    console.log(label, 'err', `${e.name}|${e.code}|${e.message}`);
  }
};

const sync = (fd) => fs.fsyncSync(fd);
const dataSync = (fd) => fs.fdatasyncSync(fd);
const truncate = (fd, len) => fs.ftruncateSync(fd, len);
const truncateDefault = (fd) => fs.ftruncateSync(fd);
const chmod = (fd, mode) => fs.fchmodSync(fd, mode);
const chown = (fd, uid, gid) => fs.fchownSync(fd, uid, gid);
const setTimes = (fd, atime, mtime) => fs.futimesSync(fd, atime, mtime);
const readv = (fd, buffers, position) => fs.readvSync(fd, buffers, position);
const readvDefault = (fd, buffers) => fs.readvSync(fd, buffers);
const writev = (fd, buffers, position) => fs.writevSync(fd, buffers, position);
const writevDefault = (fd, buffers) => fs.writevSync(fd, buffers);
const close = (fd) => fs.closeSync(fd);

// ── fsyncSync / fdatasyncSync ─────────────────────────────────────────
const fd = fs.openSync(scratch, 'r+');
try {
  show('fsync', () => sync(fd));
  show('fdatasync', () => dataSync(fd));
  show('fsync string fd', () => sync('x'));
  show('fsync null fd', () => sync(null));
  show('fsync negative fd', () => sync(-1));
  show('fdatasync huge fd', () => dataSync(2147483648));

  // ── closeSync ─────────────────────────────────────────────────────
  const closing = fs.openSync(scratch, 'r');
  show('close', () => close(closing));
  show('close twice', () => close(closing));
  show('close string fd', () => close('x'));
  show('close fraction fd', () => close(1.5));

  // ── ftruncateSync ─────────────────────────────────────────────────
  show('truncate 4', () => (truncate(fd, 4), fs.readFileSync(scratch, 'utf8')));
  show('truncate default', () => (truncateDefault(fd), fs.fstatSync(fd).size));
  show('truncate negative', () => (truncate(fd, -1), fs.fstatSync(fd).size));
  show('truncate fraction', () => truncate(fd, 1.5));
  show('truncate null', () => truncate(fd, null));
  show('truncate string fd', () => truncate('x', 1));
  show('truncate closed fd', () => {
    const closed = fs.openSync(scratch, 'r+');
    close(closed);
    return truncate(closed, 1);
  });

  // ── fchmodSync ────────────────────────────────────────────────────
  show('chmod 0640', () => (chmod(fd, 0o640), fs.fstatSync(fd).mode & 0o777));
  show('chmod string', () => (chmod(fd, '0600'), fs.fstatSync(fd).mode & 0o777));
  show('chmod undefined', () => chmod(fd, undefined));
  show('chmod string invalid', () => chmod(fd, 'rubbish'));
  show('chmod negative', () => chmod(fd, -1));
  show('chmod bad fd (mode first)', () => chmod('x', undefined));
  show('chmod closed fd', () => {
    const closed = fs.openSync(scratch, 'r+');
    close(closed);
    return chmod(closed, 0o600);
  });

  // ── fchownSync ────────────────────────────────────────────────────
  const stat = fs.fstatSync(fd);
  show('chown self', () => chown(fd, stat.uid, stat.gid));
  show('chown -1', () => chown(fd, -1, -1));
  show('chown huge uid', () => chown(fd, 4294967296, 0));
  show('chown huge gid', () => chown(fd, 0, 4294967296));
  show('chown fraction', () => chown(fd, 1.5, 0));
  show('chown uid before gid', () => chown(fd, 'x', 1.5));
  show('chown fd last', () => chown('x', 1.5, 0));
  show('chown closed fd', () => {
    const closed = fs.openSync(scratch, 'r+');
    close(closed);
    return chown(closed, stat.uid, stat.gid);
  });

  // ── futimesSync ───────────────────────────────────────────────────
  show('times numbers', () => (setTimes(fd, 1000, 2000), fs.fstatSync(fd).mtimeMs));
  show('times date', () => (setTimes(fd, new Date(3000), new Date(4000)), fs.fstatSync(fd).atimeMs));
  show('times string', () => (setTimes(fd, '1234.5', '2345'), fs.fstatSync(fd).mtimeMs));
  show('times object', () => setTimes(fd, {}, 0));
  show('times bad fd', () => setTimes('x', 1, 2));

  // ── readvSync / writevSync ────────────────────────────────────────
  show('writev current', () => writevDefault(fd, [Buffer.from('ab'), new Uint16Array([0x4443])]));
  show('writev positioned', () => writev(fd, [Buffer.from('XY'), Buffer.from('Z')], 1));
  show('writev empty', () => writevDefault(-1, []));
  show('writev not array', () => writevDefault(fd, 'x'));
  show('writev bad element', () => writevDefault(fd, [Buffer.from('a'), 1]));
  show('writev fraction position', () => writev(fd, [Buffer.from('Z')], 1.5));
  show('writev bad fd', () => writevDefault(-1, [Buffer.from('Z')]));

  // The views are named so each keeps its own type: the vector itself is
  // untyped, but the reads back out of it are not element accesses on a
  // Buffer-or-Uint16Array union.
  const first = Buffer.alloc(2, 46);
  const middle = Buffer.alloc(0);
  const words = new Uint16Array(1);
  show('readv scatter', () => readvDefault(fd, [first, middle, words]));
  console.log('readv bytes', first.toString('utf8'), words[0]);
  show('readv positioned', () => readv(fd, [Buffer.alloc(1)], 0));
  show('readv empty vector', () => readvDefault(fd, [Buffer.alloc(0)]));
  show('readv empty array', () => readvDefault(fd, []));
  show('readv bad fd', () => readvDefault(-1, [Buffer.alloc(1)]));
  show('readv not array', () => readvDefault(fd, {}));
} finally {
  fs.closeSync(fd);
}
show('fsync closed', () => sync(fd));
console.log('bytes', fs.readFileSync(scratch).toString('hex'));
fs.unlinkSync(scratch);
