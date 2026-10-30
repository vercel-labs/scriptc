// Namespace imports of supported builtins (`import * as fs ...`): every
// member lowers through the SAME tables as the named-import form — calls,
// constants (path.sep, os.EOL), fs.constants access bits, and the nested
// fs.promises module object (the same module as node:fs/promises, Node's
// rule). Scratch names derive from argv[1]'s tail so the concurrently
// running Node and native sides never collide (see 992).
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function tail(p: string): string {
  let i = p.length - 1;
  while (i >= 0 && p.charAt(i) !== "/" && p.charAt(i) !== "\\") {
    i = i - 1;
  }
  return p.slice(i + 1);
}

const scratch = "tmp-957-" + tail(process.argv[1]) + "-" + process.pid;
if (fs.existsSync(scratch)) {
  fs.rmSync(scratch + "/a.txt");
  fs.rmdirSync(scratch);
}

// path: calls (variadic join, two-arg relative) and constants
const joined = path.join("a", "b", "c.txt");
console.log("join", joined, path.dirname(joined), path.basename(joined), path.extname(joined));
console.log("sep", path.sep, "delimiter", path.delimiter, "isAbsolute", path.isAbsolute(joined));
console.log("relative", path.relative("a/b", "a/d"));

// os: calls and the EOL constant; tmpdir/homedir agree between the sides
console.log("eol", JSON.stringify(os.EOL), "platform", os.platform() === process.platform);
console.log("tmpdir-abs", path.isAbsolute(os.tmpdir()), "homedir-abs", path.isAbsolute(os.homedir()));

// fs: the write/read/stat/access surface through the namespace
fs.mkdirSync(scratch);
fs.writeFileSync(scratch + "/a.txt", "héllo ns 🌍\n");
fs.appendFileSync(scratch + "/a.txt", "second line\n");
console.log("read", fs.readFileSync(scratch + "/a.txt", "utf8"));
console.log("exists", fs.existsSync(scratch + "/a.txt"), fs.statSync(scratch + "/a.txt").isFile());
console.log("dir", fs.readdirSync(scratch).join(","));
fs.accessSync(scratch + "/a.txt", fs.constants.R_OK);
console.log("bits", fs.constants.F_OK, fs.constants.R_OK, fs.constants.W_OK, fs.constants.X_OK);

// crypto through the namespace: shape-only (the value is random)
const uuid = crypto.randomUUID();
console.log("uuid", uuid.length, uuid.charAt(8) === "-", uuid.charAt(23) === "-");

// fs.promises IS the fs/promises module (Node's rule): the nested member
// access lowers through the fs/promises table.
async function promised(): Promise<void> {
  await fs.promises.writeFile(scratch + "/b.txt", "via fs.promises\n");
  const text = await fs.promises.readFile(scratch + "/b.txt", "utf8");
  console.log("fsp", text === "via fs.promises\n");
  await fs.promises.rm(scratch + "/b.txt");
  fs.rmSync(scratch + "/a.txt");
  fs.rmdirSync(scratch);
  console.log("done", fs.existsSync(scratch));
}

promised();
