// process.loadEnvFile: parse a dotenv file into process.env — plain,
// quoted and export-prefixed assignments, comments and blank lines, names
// without values, and no expansion — then a second call overrides the
// entries it names. Missing files answer ENOENT; a non-string path answers
// ERR_INVALID_ARG_TYPE.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriptc-envfile-"));
const file = path.join(dir, "probe.env");
const names = ["SCRIPTC_B5_A", "SCRIPTC_B5_B", "SCRIPTC_B5_C", "SCRIPTC_B5_D", "SCRIPTC_B5_E"];
for (const name of names) delete process.env[name];
fs.writeFileSync(
  file,
  [
    "SCRIPTC_B5_A=1",
    "# comment",
    "SCRIPTC_B5_B=\"two words\"",
    "export SCRIPTC_B5_C=3",
    "SCRIPTC_B5_D=${SCRIPTC_B5_A}x",
    "SCRIPTC_B5_E",
    "",
  ].join("\n"),
);
process.loadEnvFile(file);
console.log(
  process.env.SCRIPTC_B5_A,
  process.env.SCRIPTC_B5_B,
  process.env.SCRIPTC_B5_C,
  process.env.SCRIPTC_B5_D,
  process.env.SCRIPTC_B5_E,
);
fs.writeFileSync(file, "SCRIPTC_B5_A=changed\n");
process.loadEnvFile(file);
console.log("again", process.env.SCRIPTC_B5_A, process.env.SCRIPTC_B5_B);
try {
  process.loadEnvFile(path.join(dir, "missing.env"));
} catch (error) {
  console.log("missing", error.code, error instanceof Error);
}
try {
  process.loadEnvFile(42);
} catch (error) {
  console.log("bad", error.code, error instanceof TypeError);
}
fs.rmSync(dir, { recursive: true, force: true });
