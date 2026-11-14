// fs.close(fd, callback) only defaults the callback when it is omitted or
// undefined. null and every other non-callable value go through Node's
// makeCallback check, which throws ERR_INVALID_ARG_TYPE at the call and
// leaves the descriptor open; a valid callback still closes it.
//
// Everything printed here is a fact both platforms share: the error name and
// code, the documented part of the message (the text before "Received"), and
// whether the file opened above is still reachable through its descriptor.
// The rendering of the received value is not contract, so it is not printed.
//
// A closed descriptor NUMBER can be handed to an unrelated descriptor — this
// runtime's event loop opens its own on the first sleep — so "still open" is
// decided by whether fstat reports the file that was opened, not by whether
// the number happens to exist. Node's loop opens its descriptors before user
// code, so there the number simply reports EBADF; both are "closed".
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "close-invalid-"));
const file = path.join(dir, "a.txt");
fs.writeFileSync(file, "hello");

const cases = [
  ["null", null],
  ["zero", 0],
  ["false", false],
  ["string", "x"],
  ["object", {}],
  ["array", []],
];

// Node's ERR_INVALID_ARG_TYPE text is "The <subject> must be ..." plus a
// "Received ..." tail describing the value that failed. Only the first part
// is documented.
const documented = (message) => {
  const at = message.indexOf(". Received");
  return at < 0 ? message : message.slice(0, at + 1);
};

const identity = (fd) => {
  const stats = fs.fstatSync(fd);
  return { dev: stats.dev, ino: stats.ino };
};

function state(fd, id) {
  try {
    const stats = fs.fstatSync(fd);
    return stats.isFile() && stats.dev === id.dev && stats.ino === id.ino ? "open" : "closed";
  } catch {
    return "closed";
  }
}

for (const [label, value] of cases) {
  const fd = fs.openSync(file, "r");
  const id = identity(fd);
  try {
    fs.close(fd, value);
    console.log(label, "accepted");
  } catch (error) {
    const still = state(fd, id);
    console.log(label, error.name, error.code, JSON.stringify(documented(error.message)), "fd", still);
    if (still === "open") fs.closeSync(fd);
  }
}

// An explicit undefined takes the default callback, so the close is a request
// that completes on a later turn. Wait for the descriptor to report closed
// rather than assuming how many turns that takes.
const explicit = fs.openSync(file, "r");
const explicitId = identity(explicit);
const returned = fs.close(explicit, undefined);
const afterClose = (attempt) => {
  if (state(explicit, explicitId) === "open" && attempt < 200) {
    setTimeout(() => afterClose(attempt + 1), 5);
    return;
  }
  console.log("undefined", returned, state(explicit, explicitId));

  const called = fs.openSync(file, "r");
  const calledId = identity(called);
  fs.close(called, (error) => {
    console.log("callback", error, state(called, calledId));
    fs.rmSync(dir, { recursive: true, force: true });
    console.log("removed", fs.existsSync(dir));
  });
};
afterClose(0);
