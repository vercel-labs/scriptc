// Node calls options.buffer(size) as a method of the options object, so a
// factory that reads `this` sees the options.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "readthis-"));
const file = path.join(root, "data.txt");
fs.writeFileSync(file, "hello buffer factory");
const options = {
  target: Buffer.alloc(64),
  buffer: function (size) {
    console.log("this is options", this === options, "size", size);
    return this.target;
  },
};
const out = fs.readFileSync(file, options);
console.log("read", out.toString(), out === options.target.subarray(0, out.length));
const optionsLiteral = {
  buffer: function (size) {
    console.log("literal this has buffer", typeof this.buffer === "function", size);
    return Buffer.alloc(size);
  },
};
console.log("literal read", fs.readFileSync(file, optionsLiteral).toString());
const withEncoding = {
  encoding: "utf8",
  target: Buffer.alloc(64),
  buffer: function (size) {
    console.log("encoding this is options", this === withEncoding, size);
    return this.target;
  },
};
console.log("encoded read", fs.readFileSync(file, withEncoding));
fs.rmSync(root, { recursive: true, force: true });
