// SystemError's documented fields, as Node's errors chapter lists them:
// code, errno, syscall, path, dest, address, port and info, on the errors
// the filesystem, net, dns and http raise. Each line names the operation
// and the field values Node answers; `info` is the extra record some
// operating systems' calls carry.
import fs from "node:fs";
import net from "node:net";
import dns from "node:dns";
import os from "node:os";
import path from "node:path";

// A private directory: another process may leave a file or a directory at a
// fixed name under the shared temporary directory, which would turn the
// errors below into different ones (or none at all).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scriptc-system-error-fields-"));

/** The private directory's random suffix is the only part of a path that
 * differs between the Node oracle and the compiled program; print it as a
 * fixed placeholder so their output stays comparable. */
function stable(value) {
  return String(value).split(tmp).join("<tmp>");
}

/** `errno` is negative on Linux; print its magnitude direction, not the
 * value, since the number is platform-specific. */
function errno(error) {
  return typeof error.errno === "number" ? (error.errno < 0 ? "negative" : "non-negative") : String(error.errno);
}

/** `JSON.stringify`, with an absent value spelled out (an error's fields
 * are absent, not undefined-valued, and printing both alike would hide a
 * difference). */
function show(value) {
  if (value === undefined) return "absent";
  return JSON.stringify(typeof value === "string" ? stable(value) : value);
}

function fields(label, error) {
  const parts = [
    error.name,
    error.code,
    errno(error),
    error.syscall,
    show(error.path),
    show(error.dest),
    show(error.address),
    show(error.port),
    error.info === undefined ? "no-info" : "info",
  ];
  console.log(label, parts.join(" | "));
  console.log(label, "message", JSON.stringify(stable(error.message)));
  // The documented fields, in sorted order: Node's C++ insertion order
  // for a SystemError is not part of the documented surface.
  console.log(label, "own", Object.getOwnPropertyNames(error).sort().join(","));
}

// ENOENT: open.
try {
  fs.readFileSync(path.join(tmp, "scriptc-no-such-file.txt"));
} catch (error) {
  fields("readFileSync", error);
}
// ENOENT: a missing parent directory on write.
try {
  fs.writeFileSync(path.join(tmp, "scriptc-no-such-dir", "file.txt"), "x");
} catch (error) {
  fields("writeFileSync", error);
}
// EISDIR: reading a directory as a file.
try {
  fs.readFileSync(tmp);
} catch (error) {
  fields("readFileSync-dir", error);
}
// ENOENT: rename reports the destination in `dest`.
try {
  fs.renameSync(path.join(tmp, "scriptc-missing-src.txt"), path.join(tmp, "scriptc-missing-dst.txt"));
} catch (error) {
  fields("renameSync", error);
}
// os.setPriority is a SystemError with `info` (the call's own detail).
try {
  os.setPriority(999999, 0);
} catch (error) {
  fields("setPriority", error);
  console.log("setPriority", "info fields", Object.keys(error.info).sort().join(","));
}

// ECONNREFUSED: the address and port of the refused connection.
net.connect(1, "127.0.0.1").on("error", (error) => {
  fields("connect", error);
  // ESRCH is a dns lookup of a name that cannot resolve.
  dns.lookup("scriptc-no-such-host.invalid", (lookupError) => {
    if (lookupError) fields("lookup", lookupError);
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log("done");
  });
});
