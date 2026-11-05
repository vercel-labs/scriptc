// fs.readSync with bigint positions reads at the exact position, including
// past 2^53 (beyond a one-byte file's end, so it reads nothing), leaves the
// descriptor's offset unchanged, and -1n reads at the current offset.
// Positions outside [-1n, 2n ** 63n - 1n - length] throw ERR_OUT_OF_RANGE.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriptc-read-position-"));
const file = path.join(dir, "data");
fs.writeFileSync(file, "xyz");
const fd = fs.openSync(file, "r");
const buffer = Buffer.alloc(2);
try {
  console.log(fs.readSync(fd, buffer, 0, 1, 0n), buffer.toString("latin1", 0, 1));
  console.log(fs.readSync(fd, buffer, 0, 2, 1n), buffer.toString("latin1"));
  console.log(fs.readSync(fd, buffer, 0, 1, 9007199254740993n));
  console.log(fs.readSync(fd, buffer, 0, 1, 9223372036854775806n));
  // The positioned reads above left the current offset at 0.
  console.log(fs.readSync(fd, buffer, 0, 1, -1n), buffer.toString("latin1", 0, 1));
  console.log(fs.readSync(fd, buffer, 0, 1, -1n), buffer.toString("latin1", 0, 1));
  for (const position of [-2n, 9223372036854775807n]) {
    try {
      fs.readSync(fd, buffer, 0, 1, position);
    } catch (error) {
      console.log(error.code, error.message);
    }
  }
} finally {
  fs.closeSync(fd);
  fs.rmSync(dir, { recursive: true });
}
