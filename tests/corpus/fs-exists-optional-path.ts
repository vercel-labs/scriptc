// fs.existsSync over a value that is not statically a string.
// @normalize-pid
// A Buffer path, a union of strings and Buffers, and `any`-typed values. Node
// answers false for a value that is not a path and reports DEP0187 once, so
// the report appears on stderr exactly once for the whole program. A stored
// function value takes the same paths.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const scratch = path.join(os.tmpdir(), `scr-exists-${process.pid}.txt`);
fs.writeFileSync(scratch, "x");

const buffer = Buffer.from(scratch, "utf8");
const either: string | Buffer = process.argv.length > 100000 ? Buffer.from(scratch) : scratch;
const dynamic: any = JSON.parse("null");
const listed: any = JSON.parse(`["${scratch}"]`);
const stored = fs.existsSync;

console.log("string:", fs.existsSync(scratch));
console.log("missing string:", fs.existsSync(scratch + ".absent"));
console.log("empty string:", fs.existsSync(""));
console.log("buffer:", fs.existsSync(buffer));
console.log("missing buffer:", fs.existsSync(Buffer.from(scratch + ".absent", "utf8")));
console.log("union string:", fs.existsSync(either));
console.log("stored buffer:", stored(buffer));
console.log("any null:", fs.existsSync(dynamic));
console.log("any listed:", fs.existsSync(listed[0]));
console.log("any missing index:", fs.existsSync(listed[1]));

fs.unlinkSync(scratch);
