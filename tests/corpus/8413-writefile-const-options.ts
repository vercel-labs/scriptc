// writeFileSync(p, data, options) accepts the options as a `const`
// binding: the literal behind it is the options record. The mode is
// open(2)'s O_CREAT argument (creation only — an existing file keeps its
// permissions, exactly Node) and the encoding may only spell the utf8 the
// runtime writes anyway.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SCRATCH_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scr-8413-"));
const created = path.join(dir, "created.json");

fs.writeFileSync(created, "{}", SCRATCH_OPTIONS);
console.log("created:", fs.readFileSync(created).toString("utf8"));
console.log("mode:", (fs.statSync(created).mode & 0o777).toString(8));

// An existing file keeps its permissions: the mode is creation-only.
const existing = path.join(dir, "existing.json");
fs.writeFileSync(existing, "seed", { encoding: "utf8", mode: 0o644 });
fs.writeFileSync(existing, "rewritten", SCRATCH_OPTIONS);
console.log("existing:", fs.readFileSync(existing).toString("utf8"));
console.log("existing mode:", (fs.statSync(existing).mode & 0o777).toString(8));

fs.rmSync(dir, { recursive: true, force: true });
console.log("removed:", fs.existsSync(dir));
