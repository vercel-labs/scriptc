// writeFileSync(fd, data): Node accepts an open file descriptor where it
// accepts a path, writes the whole data from the descriptor's current
// offset, and leaves the descriptor open.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const scratch = path.join(os.tmpdir(), `scriptc-write-fd-${process.pid}.txt`);
const fd = fs.openSync(scratch, "w");
fs.writeFileSync(fd, "hello ");
fs.writeFileSync(fd, "world");
fs.closeSync(fd);
console.log(fs.readFileSync(scratch, "utf8"));
fs.rmSync(scratch);
