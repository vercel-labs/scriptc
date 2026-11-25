// A failed spawn's 'error' event carries Node's errnoException: errno,
// code, syscall "spawn <file>", path and spawnargs, one object for every
// listener. The children run one after another, so the lines have one order.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-error-"));
const clean = (v) => (typeof v === "string" ? v.split(dir).join("<tmp>") : v);
const plainFile = path.join(dir, "plain.sh");
fs.writeFileSync(plainFile, "#!/bin/sh\necho hi\n", { mode: 0o644 });

function show(label, e) {
  console.log(
    label,
    e instanceof Error,
    e.name,
    e.code,
    typeof e.errno,
    e.errno < 0,
    clean(e.syscall),
    clean(e.path),
    JSON.stringify(e.spawnargs.map(clean)),
    JSON.stringify(clean(e.message)),
    Object.keys(e).join(","),
  );
}

const cases = [
  ["absolute", () => spawn("/definitely/not/here", ["a", "b"]), "ENOENT"],
  ["lookup", () => spawn("definitely-not-a-command", ["x"]), "ENOENT"],
  ["no arguments", () => spawn("/definitely/not/here"), "ENOENT"],
  ["not executable", () => spawn(plainFile, ["one"]), "EACCES"],
  ["missing cwd", () => spawn("echo", ["hi"], { cwd: path.join(dir, "missing") }), "ENOENT"],
];

// A child handed to a function that knows nothing about it: the listener is
// registered through the untyped value.
function listen(child, label, then) {
  child.once("error", (e) => {
    show(label, e);
    then();
  });
}

function run(index) {
  if (index === cases.length) {
    listen(spawn("/definitely/not/here", ["through", "a", "helper"]), "untyped child", () => {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log("done");
    });
    return;
  }
  const [label, start, code] = cases[index];
  const child = start();
  let first;
  child.on("error", (e) => {
    first = e;
    show(label, e);
    console.log(label, "child", child.pid, child.killed);
  });
  child.once("error", (e) => {
    console.log(label, "same object", e === first, e.code === code, os.constants.errno[code] === -e.errno);
    run(index + 1);
  });
}
run(0);
