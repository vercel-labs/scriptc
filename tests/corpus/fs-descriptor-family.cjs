// The descriptor family beyond read/write: readv and writev over buffer
// lists (position, empty list, element validation, payload identity),
// fdatasync, fchmod and ftruncate, in the sync and callback forms, with
// Node's validation ladder and error shapes.
'use strict';
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "descriptor-family-"));
const file = path.join(dir, "f.txt");
fs.writeFileSync(file, "");
const show = (label, value) => console.log(label, JSON.stringify(value));
const report = (label, action) => {
  try {
    const value = action();
    show(label, value === undefined ? "ok" : value);
  } catch (error) {
    show(label, [error.code, error.syscall || null]);
  }
};

let fd = fs.openSync(file, "w+");
show("writev", fs.writevSync(fd, [Buffer.from("abc"), Buffer.from("def")]));
show("writev content", fs.readFileSync(file, "utf8"));
show("writev empty", fs.writevSync(fd, []));
show("writev position", fs.writevSync(fd, [Buffer.from("XY")], 1));
show("writev position content", fs.readFileSync(file, "utf8"));
show("writev undefined position", fs.writevSync(fd, [Buffer.from("Z")], undefined));
report("writev string", () => fs.writevSync(fd, "nope"));
report("writev number element", () => fs.writevSync(fd, [1]));
report("writev bad fd", () => fs.writevSync(9999, [Buffer.from("a")]));
report("writev negative position", () => fs.writevSync(fd, [Buffer.from("a")], -1));
report("writev nan position", () => fs.writevSync(fd, [Buffer.from("a")], NaN));

const buffers = [Buffer.alloc(2), Buffer.alloc(6, 46)];
show("readv", fs.readvSync(fd, buffers, 0));
show("readv content", [buffers[0].toString(), buffers[1].toString()]);
report("readv empty", () => fs.readvSync(fd, [], 0));
report("readv bad fd", () => fs.readvSync(9999, [Buffer.alloc(1)], 0));
report("readv string", () => fs.readvSync(fd, "nope", 0));
report("readv bad element", () => fs.readvSync(fd, [{}], 0));
report("readv fraction position", () => fs.readvSync(fd, [Buffer.alloc(1)], 0.5));

report("fdatasync", () => fs.fdatasyncSync(fd));
report("fdatasync bad fd", () => fs.fdatasyncSync(9999));
report("fchmod", () => fs.fchmodSync(fd, 0o600));
show("fchmod mode", fs.fstatSync(fd).mode & 0o777);
report("fchmod undefined mode", () => fs.fchmodSync(fd, undefined));
report("fchmod bad fd", () => fs.fchmodSync(9999, 0o600));
report("ftruncate", () => fs.ftruncateSync(fd, 2));
show("ftruncate size", fs.fstatSync(fd).size);
report("ftruncate undefined", () => fs.ftruncateSync(fd, undefined));
show("ftruncate undefined size", fs.fstatSync(fd).size);
report("ftruncate fraction", () => fs.ftruncateSync(fd, 1.5));
report("ftruncate bad fd", () => fs.ftruncateSync(9999, 1));
fs.closeSync(fd);

function step(start) {
  return new Promise((resolve) => start(resolve));
}

async function callbacks() {
  fd = fs.openSync(file, "w+");
  await step((next) =>
    fs.writev(fd, [Buffer.from("ghi"), Buffer.from("jkl")], (error, written, used) => {
      console.log("writev callback", error ? error.code : written, used && used.length);
      next(0);
    }),
  );
  show("writev callback content", fs.readFileSync(file, "utf8"));
  const source = [Buffer.from("mn")];
  await step((next) =>
    fs.writev(fd, source, 0, (error, written, used) => {
      console.log("writev callback position", error ? error.code : written, used === source);
      next(0);
    }),
  );
  const target = [Buffer.alloc(3), Buffer.alloc(4, 46)];
  await step((next) =>
    fs.readv(fd, target, 0, (error, read, used) => {
      console.log("readv callback", error ? error.code : read, used === target, target[0].toString(), target[1].toString());
      next(0);
    }),
  );
  await step((next) =>
    fs.fdatasync(fd, (error) => {
      console.log("fdatasync callback", error ? error.code : "ok");
      next(0);
    }),
  );
  await step((next) =>
    fs.fchmod(fd, 0o640, (error) => {
      console.log("fchmod callback", error ? error.code : "ok", fs.fstatSync(fd).mode & 0o777);
      next(0);
    }),
  );
  await step((next) =>
    fs.ftruncate(fd, 3, (error) => {
      console.log("ftruncate callback", error ? error.code : "ok", fs.fstatSync(fd).size);
      next(0);
    }),
  );
  fs.closeSync(fd);
  try {
    fs.writev(fd, "nope", () => console.log("writev invalid buffers unexpected"));
    console.log("writev invalid buffers threw");
  } catch (error) {
    console.log("writev invalid buffers", error.code);
  }
  try {
    fs.readv(fd, [{}], () => console.log("readv invalid element unexpected"));
    console.log("readv invalid element threw");
  } catch (error) {
    console.log("readv invalid element", error.code);
  }
  try {
    fs.readv(-1, [Buffer.alloc(1)], () => console.log("readv invalid fd unexpected"));
    console.log("readv invalid fd threw");
  } catch (error) {
    console.log("readv invalid fd", error.code);
  }
  await step((next) =>
    fs.fdatasync(9999, (error) => {
      console.log("fdatasync bad fd", error.code, error.syscall);
      next(0);
    }),
  );
  await step((next) =>
    fs.fchmod(9999, 0o600, (error) => {
      console.log("fchmod bad fd", error.code, error.syscall);
      next(0);
    }),
  );
  await step((next) =>
    fs.ftruncate(9999, 1, (error) => {
      console.log("ftruncate bad fd", error.code, error.syscall);
      next(0);
    }),
  );
}

callbacks().then(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
