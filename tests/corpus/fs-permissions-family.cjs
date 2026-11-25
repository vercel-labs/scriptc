// The permission family: access modes through the F_OK..X_OK range and
// its rejections, chmod's number and octal-string modes, chown, lchown and
// fchown with the -1 no-op and the current owner, and truncate/ftruncate
// with the omitted, negative and fractional lengths, in the sync and
// callback forms.
'use strict';
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "permissions-family-"));
const file = path.join(dir, "f.txt");
const missing = path.join(dir, "missing");
fs.writeFileSync(file, "hello");

const show = (label, value) => console.log(label, JSON.stringify(value));
const report = (label, action) => {
  try {
    const value = action();
    show(label, value === undefined ? "ok" : value);
  } catch (error) {
    show(label, [error.code, error.syscall || null, String(error.message).includes(dir) ? "named" : "plain"]);
  }
};
const uid = process.getuid();
const gid = process.getgid();

for (const mode of [0, 1, 2, 4, 6, 7]) report(`access ${mode}`, () => fs.accessSync(file, mode));
report("access 8", () => fs.accessSync(file, 8));
report("access -1", () => fs.accessSync(file, -1));
report("access nan", () => fs.accessSync(file, NaN));
report("access infinity", () => fs.accessSync(file, Infinity));
report("access fraction", () => fs.accessSync(file, 1.5));
report("access undefined", () => fs.accessSync(file, undefined));
report("access null", () => fs.accessSync(file, null));
report("access missing", () => fs.accessSync(missing, 0));

fs.chmodSync(file, 0o600);
show("chmod number", fs.statSync(file).mode & 0o777);
fs.chmodSync(file, "644");
show("chmod string", fs.statSync(file).mode & 0o777);
fs.chmodSync(file, "0640");
show("chmod octal string", fs.statSync(file).mode & 0o777);
report("chmod invalid string", () => fs.chmodSync(file, "zz"));
report("chmod -1", () => fs.chmodSync(file, -1));
report("chmod fraction", () => fs.chmodSync(file, 420.5));
report("chmod undefined", () => fs.chmodSync(file, undefined));

report("chown same owner", () => fs.chownSync(file, uid, gid));
report("chown -1", () => fs.chownSync(file, -1, -1));
report("lchown -1", () => fs.lchownSync(file, -1, -1));
report("chown fraction", () => fs.chownSync(file, 0.5, gid));
report("chown negative", () => fs.chownSync(file, -2, gid));
report("chown missing", () => fs.chownSync(missing, uid, gid));

const fd = fs.openSync(file, "r+");
report("fchown -1", () => fs.fchownSync(fd, -1, -1));
report("fchmod 600", () => fs.fchmodSync(fd, 0o600));
report("fchmod string", () => fs.fchmodSync(fd, "600"));
report("fchmod undefined", () => fs.fchmodSync(fd, undefined));
report("fchmod bad fd", () => fs.fchmodSync(9999, 0o600));
report("ftruncate 3", () => fs.ftruncateSync(fd, 3));
show("ftruncate size", fs.fstatSync(fd).size);
report("ftruncate undefined", () => fs.ftruncateSync(fd, undefined));
show("ftruncate undefined size", fs.fstatSync(fd).size);
report("ftruncate -1", () => fs.ftruncateSync(fd, -1));
show("ftruncate negative size", fs.fstatSync(fd).size);
report("ftruncate fraction", () => fs.ftruncateSync(fd, 0.5));
report("ftruncate bad fd", () => fs.ftruncateSync(9999, 1));
fs.closeSync(fd);

report("truncate 2", () => fs.truncateSync(file, 2));
show("truncate size", fs.statSync(file).size);
report("truncate undefined", () => fs.truncateSync(file, undefined));
show("truncate undefined size", fs.statSync(file).size);
report("truncate -1", () => fs.truncateSync(file, -1));
report("truncate fraction", () => fs.truncateSync(file, 1.5));
report("truncate missing", () => fs.truncateSync(missing, 1));

function step(start) {
  return new Promise((resolve) => start(resolve));
}

async function callbacks() {
  await step((next) =>
    fs.access(file, 4, (error) => {
      console.log("access callback", error ? error.code : "ok");
      next(0);
    }),
  );
  await step((next) =>
    fs.access(file, undefined, (error) => {
      console.log("access callback undefined", error ? error.code : "ok");
      next(0);
    }),
  );
  try {
    fs.access(file, 8, (error) => console.log("access callback 8 unexpected", error));
    console.log("access callback 8 threw");
  } catch (error) {
    console.log("access callback 8", error.code);
  }
  await step((next) =>
    fs.access(missing, 0, (error) => {
      console.log("access callback missing", error.code, error.syscall);
      next(0);
    }),
  );
  await step((next) =>
    fs.chmod(file, "664", (error) => {
      console.log("chmod callback", error ? error.code : "ok", fs.statSync(file).mode & 0o777);
      next(0);
    }),
  );
  await step((next) =>
    fs.chown(file, uid, gid, (error) => {
      console.log("chown callback", error ? error.code : "ok");
      next(0);
    }),
  );
  await step((next) =>
    fs.lchown(file, -1, -1, (error) => {
      console.log("lchown callback", error ? error.code : "ok");
      next(0);
    }),
  );
  const handle = fs.openSync(file, "r+");
  await step((next) =>
    fs.fchown(handle, -1, -1, (error) => {
      console.log("fchown callback", error ? error.code : "ok");
      next(0);
    }),
  );
  await step((next) =>
    fs.fchmod(handle, 0o640, (error) => {
      console.log("fchmod callback", error ? error.code : "ok");
      next(0);
    }),
  );
  await step((next) =>
    fs.ftruncate(handle, 4, (error) => {
      console.log("ftruncate callback", error ? error.code : "ok", fs.fstatSync(handle).size);
      next(0);
    }),
  );
  fs.closeSync(handle);
  await step((next) =>
    fs.truncate(file, 1, (error) => {
      console.log("truncate callback", error ? error.code : "ok", fs.statSync(file).size);
      next(0);
    }),
  );
  await step((next) =>
    fs.truncate(file, undefined, (error) => {
      console.log("truncate callback undefined", error ? error.code : "ok", fs.statSync(file).size);
      next(0);
    }),
  );
  await step((next) =>
    fs.truncate(missing, 1, (error) => {
      console.log("truncate callback missing", error.code, error.syscall);
      next(0);
    }),
  );
}

callbacks().then(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
