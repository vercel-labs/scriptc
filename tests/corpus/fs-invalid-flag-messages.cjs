// stringToFlags' refusal over the flags the sync fs calls read: an
// oversized name, one carrying a NUL byte, and one carrying a quote print
// Node's ERR_INVALID_ARG_VALUE with the value inspected and truncated the
// way errors.js truncates it, whatever the input's length.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flag-msg-"));
const file = path.join(dir, "f.txt");
fs.writeFileSync(file, "x");
const clean = (text) => text.split(dir).join("<dir>");
function t(label, run) {
  try {
    run();
    console.log(label, "accepted");
  } catch (error) {
    console.log(
      label,
      error.name,
      error.code,
      error.message.length,
      JSON.stringify(clean(error.message.slice(0, 60))),
      JSON.stringify(clean(error.message.slice(-24))),
    );
  }
}
const huge = "z".repeat(100000);
t("readFileSync huge", () => fs.readFileSync(file, { flag: huge }));
t("readFileSync nul", () => fs.readFileSync(file, { flag: "r\u0000x" }));
t("readFileSync quote", () => fs.readFileSync(file, { flag: "r'q" }));
t("openSync huge", () => fs.openSync(file, huge));
t("openSync nul", () => fs.openSync(file, "r\u0000x"));
t("openSync quote", () => fs.openSync(file, "r'q"));
t("writeFileSync huge", () => fs.writeFileSync(file, "x", { flag: huge }));
t("writeFileSync nul", () => fs.writeFileSync(file, "x", { flag: "r\u0000x" }));
fs.rmSync(dir, { recursive: true, force: true });
