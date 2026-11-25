// fs.exists and fs.existsSync across the path kinds Node accepts and rejects.
// @normalize-pid
// existsSync answers false for every path getValidatedPath rejects — a null
// byte in a string or Buffer, a non-file URL, and any value that is not a
// path — and reports DEP0187 once for the invalid-argument kinds. exists
// validates its callback first; a rejected path answers false through the
// callback synchronously (inside the call), while a string, Buffer or file:
// URL path probes asynchronously. The callback answers are chained so their
// threadpool completion order never shows in the output.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "fs-exists-kinds-"));
const file = path.join(root, "file.txt");
const missing = path.join(root, "missing.txt");
fs.writeFileSync(file, "x");

console.log("string", fs.existsSync(file), fs.existsSync(missing), fs.existsSync(""));
console.log("buffer", fs.existsSync(Buffer.from(file)), fs.existsSync(Buffer.from(missing)));
console.log("nul", fs.existsSync("a\0b"), fs.existsSync(Buffer.from("a\0b")), fs.existsSync(file + "\0"));
console.log("url", fs.existsSync(pathToFileURL(file)), fs.existsSync(pathToFileURL(missing)));
console.log("url scheme", fs.existsSync(new URL("https://example.com/x")));
console.log("url encoded slash", fs.existsSync(new URL("file:///a%2Fb")));
// Invalid argument types answer false and report DEP0187 once (stderr).
console.log("invalid", fs.existsSync(123), fs.existsSync(null), fs.existsSync(undefined));
console.log("invalid", fs.existsSync({}), fs.existsSync(true), fs.existsSync());

// The callback contract, and the synchronous false for a rejected path.
const show = (label, run) => {
  try {
    run();
    console.log(label, "returned");
  } catch (error) {
    console.log(label, error.name, error.code, error.message);
  }
};
show("no callback", () => fs.exists(file));
show("bad callback", () => fs.exists(file, {}));
show("nul bad callback", () => fs.exists("a\0b", 7));

const order = [];
fs.exists("a\0b", (found) => order.push(`nul:${found}`));
fs.exists(Buffer.from("a\0b"), (found) => order.push(`nul buffer:${found}`));
fs.exists(file + "\0", (found) => order.push(`trailing nul:${found}`));
fs.exists(42, (found) => order.push(`number:${found}`));
fs.exists(null, (found) => order.push(`null:${found}`));
fs.exists(undefined, (found) => order.push(`undefined:${found}`));
fs.exists(new URL("https://example.com/x"), (found) => order.push(`https:${found}`));
fs.exists(new URL("file:///a%2Fb"), (found) => order.push(`encoded:${found}`));
order.push("calls returned");
console.log("sync false", order.join(" "));

fs.exists(file, (found) => {
  console.log("async file", found);
  fs.exists(missing, (absent) => {
    console.log("async missing", absent);
    fs.exists(Buffer.from(file), (buffer) => {
      console.log("async buffer", buffer);
      fs.exists(pathToFileURL(file), (url) => {
        console.log("async url", url);
        fs.exists(pathToFileURL(missing), (missingUrl) => {
          console.log("async missing url", missingUrl);
          fs.unlinkSync(file);
          fs.exists(file, (gone) => {
            console.log("async unlinked", gone);
            console.log("sync unlinked", fs.existsSync(file));
            fs.rmSync(root, { recursive: true, force: true });
            console.log("removed", fs.existsSync(root));
          });
        });
      });
    });
  });
});
