// The link and time families: hard links, symlinks and readlink (plain,
// buffer and latin1 encodings, Node's type validation), and utimes,
// lutimes and futimes over Dates, numbers and strings, in the sync and
// callback forms, with the errno shapes each reports.
'use strict';
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "links-times-"));
const file = path.join(dir, "f.txt");
const hard = path.join(dir, "hard.txt");
const soft = path.join(dir, "soft.txt");
fs.writeFileSync(file, "abc");

const show = (label, value) => console.log(label, JSON.stringify(value));

fs.linkSync(file, hard);
show("linkSync", [fs.statSync(file).nlink, fs.statSync(hard).nlink]);
try {
  fs.linkSync(file, hard);
} catch (error) {
  show("linkSync exists", [error.code, error.syscall]);
}
try {
  fs.linkSync(path.join(dir, "missing.txt"), path.join(dir, "other.txt"));
} catch (error) {
  show("linkSync missing", [error.code, error.syscall]);
}

fs.symlinkSync("f.txt", soft);
fs.symlinkSync("f.txt", path.join(dir, "soft-file.txt"), "file");
try {
  fs.symlinkSync("f.txt", path.join(dir, "soft-bad.txt"), "bogus");
} catch (error) {
  show("symlinkSync bad type", [error.code, error.message.includes("Received 'bogus'")]);
}
try {
  fs.symlinkSync("f.txt", soft);
} catch (error) {
  show("symlinkSync exists", [error.code, error.syscall]);
}
show("readlinkSync", fs.readlinkSync(soft));
const softBuffer = fs.readlinkSync(soft, { encoding: "buffer" });
show("readlinkSync buffer", [Buffer.isBuffer(softBuffer), softBuffer.toString()]);
show("readlinkSync latin1", fs.readlinkSync(soft, "latin1"));
try {
  fs.readlinkSync(soft, { encoding: "zzz" });
} catch (error) {
  show("readlinkSync encoding", error.code);
}
try {
  fs.readlinkSync(file);
} catch (error) {
  show("readlinkSync not a link", [error.code, error.syscall]);
}

fs.utimesSync(file, 1.5, 2.25);
show("utimesSync numbers", [fs.statSync(file).atime.getTime(), fs.statSync(file).mtime.getTime()]);
fs.utimesSync(file, new Date(3000), new Date(4000));
show("utimesSync dates", [fs.statSync(file).atime.getTime(), fs.statSync(file).mtime.getTime()]);
fs.utimesSync(file, "5.5", "6.5");
show("utimesSync strings", [fs.statSync(file).atime.getTime(), fs.statSync(file).mtime.getTime()]);
fs.lutimesSync(soft, 7.5, 8.5);
show("lutimesSync", [fs.lstatSync(soft).atime.getTime(), fs.lstatSync(soft).mtime.getTime()]);
const fd = fs.openSync(file, "r");
fs.futimesSync(fd, 9.5, 10.5);
show("futimesSync", [fs.fstatSync(fd).atime.getTime(), fs.fstatSync(fd).mtime.getTime()]);
fs.closeSync(fd);
try {
  fs.utimesSync(file, "zzz", 2);
} catch (error) {
  show("utimesSync bad time", error.code);
}
try {
  fs.utimesSync(path.join(dir, "missing.txt"), 1, 2);
} catch (error) {
  show("utimesSync missing", [error.code, error.syscall]);
}
try {
  fs.lutimesSync(path.join(dir, "missing.txt"), 1, 2);
} catch (error) {
  show("lutimesSync missing", [error.code, error.syscall]);
}

function step(start) {
  return new Promise((resolve) => start(resolve));
}

async function callbacks() {
  await step((next) =>
    fs.link(file, path.join(dir, "hard-cb.txt"), (error) => {
      console.log("link", error ? error.code : "ok");
      next(0);
    }),
  );
  await step((next) =>
    fs.link(file, path.join(dir, "hard-cb.txt"), (error) => {
      console.log("link exists", error.code, error.syscall);
      next(0);
    }),
  );
  await step((next) =>
    fs.symlink("f.txt", path.join(dir, "soft-cb.txt"), (error) => {
      console.log("symlink", error ? error.code : "ok");
      next(0);
    }),
  );
  await step((next) =>
    fs.symlink("f.txt", path.join(dir, "soft-cb2.txt"), "file", (error) => {
      console.log("symlink type", error ? error.code : "ok");
      next(0);
    }),
  );
  await step((next) =>
    fs.readlink(path.join(dir, "soft-cb.txt"), (error, value) => {
      console.log("readlink", error ? error.code : value);
      next(0);
    }),
  );
  await step((next) =>
    fs.readlink(path.join(dir, "soft-cb.txt"), { encoding: "buffer" }, (error, value) => {
      console.log("readlink buffer", error ? error.code : Buffer.isBuffer(value), value.toString());
      next(0);
    }),
  );
  try {
    fs.readlink(path.join(dir, "soft-cb.txt"), { encoding: "zzz" }, (error, value) => {
      console.log("readlink encoding callback", error && error.code, value);
    });
  } catch (error) {
    console.log("readlink encoding threw", error.code);
  }
  await step((next) =>
    fs.utimes(file, 11.5, 12.5, (error) => {
      console.log("utimes", error ? error.code : "ok");
      next(0);
    }),
  );
  show("utimes after callback", [fs.statSync(file).atime.getTime(), fs.statSync(file).mtime.getTime()]);
  await step((next) =>
    fs.utimes(path.join(dir, "missing.txt"), 1, 2, (error) => {
      console.log("utimes missing", error.code, error.syscall);
      next(0);
    }),
  );
  await step((next) =>
    fs.lutimes(path.join(dir, "soft-cb.txt"), 13.5, 14.5, (error) => {
      console.log("lutimes", error ? error.code : "ok");
      next(0);
    }),
  );
  show("lutimes after callback", [fs.lstatSync(path.join(dir, "soft-cb.txt")).atime.getTime(), fs.lstatSync(path.join(dir, "soft-cb.txt")).mtime.getTime()]);
  const handle = fs.openSync(file, "r");
  await step((next) =>
    fs.futimes(handle, 15.5, 16.5, (error) => {
      console.log("futimes", error ? error.code : "ok");
      next(0);
    }),
  );
  show("futimes after callback", [fs.fstatSync(handle).atime.getTime(), fs.fstatSync(handle).mtime.getTime()]);
  fs.closeSync(handle);
  await step((next) =>
    fs.futimes(9999, 1, 2, (error) => {
      console.log("futimes bad fd", error.code, error.syscall);
      next(0);
    }),
  );
}

callbacks().then(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
