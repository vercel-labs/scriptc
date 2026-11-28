// A numeric option is validated, not converted: Node refuses an object with
// ERR_INVALID_ARG_TYPE before any conversion, so a valueOf that replaces the
// option while it runs is never called. The object here replaces itself to
// prove the runtime never reaches user code through the option.
const fs = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const dir = fs.mkdtempSync(join(tmpdir(), "scr-option-valueof-"));
const file = join(dir, "out.log");
const options = { dest: file };
options.minLength = {
  valueOf() {
    options.minLength = 0;
    return {};
  },
  toString() {
    return "3";
  },
};
try {
  const s = new fs.Utf8Stream(options);
  console.log("accepted", s.minLength);
} catch (err) {
  console.log("rejected", err.name, err.code, err.message);
}
const ok = new fs.Utf8Stream({ dest: file, minLength: 3 });
console.log("number option", ok.minLength);
ok.on("ready", () => {
  ok.write("ab");
  ok.end();
});
ok.on("close", () => {
  console.log("size", fs.statSync(file).size);
  fs.rmSync(dir, { recursive: true, force: true });
});

// The stream work below is deferred; keep the loop turning so it runs.
setTimeout(() => {}, 100);
