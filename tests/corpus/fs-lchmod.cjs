// fs.promises.lchmod follows Node's platform split: the promise form exists
// everywhere and rejects with ERR_METHOD_NOT_IMPLEMENTED where lchmod(2) does
// not exist, and fs.lchmod / fs.lchmodSync are not exported there at all.
const fs = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

(async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "scr-lchmod-"));
  const file = join(dir, "data.bin");
  fs.writeFileSync(file, "data");

  const attempts = [
    ["missing", () => fs.promises.lchmod(join(dir, "nope.bin"), 0o600)],
    ["file", () => fs.promises.lchmod(file, 0o600)],
    ["bad mode", () => fs.promises.lchmod(file, Number("nope"))],
  ];
  for (const [label, run] of attempts) {
    try {
      await run();
      console.log("lchmod", label, "ok");
    } catch (err) {
      console.log("lchmod", label, err.name, err.code, err.message);
    }
  }

  fs.rmSync(dir, { recursive: true, force: true });
})();
