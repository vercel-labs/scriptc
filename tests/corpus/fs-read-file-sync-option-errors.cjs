// readFileSync's options ladder in JavaScript, where every spelling reaches
// the runtime: getOptions accepts a string, an object, null or a function
// and rejects the rest; a truthy non-encoding fails assertEncoding; the
// flag goes through stringToFlags (a documented name or int32 bits); and
// "buffer" is a valid spelling that fails only when the decode runs.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfopts-"));
const file = path.join(dir, "a.txt");
fs.writeFileSync(file, "hello");

function show(label, read) {
  try {
    const value = read();
    console.log(label, "ok", typeof value === "string" ? JSON.stringify(value) : value.length);
  } catch (error) {
    console.log(label, error.name, error.code, error.message);
  }
}

show("options number", () => fs.readFileSync(file, 5));
show("options true", () => fs.readFileSync(file, true));
show("options null", () => fs.readFileSync(file, null));
show("options undefined", () => fs.readFileSync(file, undefined));
show("options function", () => fs.readFileSync(file, () => {}));
show("options empty", () => fs.readFileSync(file, {}));
show("encoding number", () => fs.readFileSync(file, { encoding: 5 }));
show("encoding bogus", () => fs.readFileSync(file, { encoding: "bogus" }));
show("encoding empty", () => fs.readFileSync(file, { encoding: "" }));
show("encoding buffer", () => fs.readFileSync(file, { encoding: "buffer" }));
show("flag true", () => fs.readFileSync(file, { flag: true }));
show("flag 1.5", () => fs.readFileSync(file, { flag: 1.5 }));
show("flag empty", () => fs.readFileSync(file, { flag: "" }));
show("flag bits", () => fs.readFileSync(file, { flag: 0 }));
show("flag bogus", () => fs.readFileSync(file, { encoding: "utf8", flag: "nope" }));
show("signal object", () => fs.readFileSync(file, { signal: {} }));
// getOptions takes any object, a plain ArrayBuffer included, but an
// ArrayBufferView reaches the binding's buffer check.
show("options buffer", () => fs.readFileSync(file, Buffer.from("x")));
show("options typed array", () => fs.readFileSync(file, new Uint16Array(2)));
show("options data view", () => fs.readFileSync(file, new DataView(new ArrayBuffer(4))));
show("options array buffer", () => fs.readFileSync(file, new ArrayBuffer(4)));
show("options empty array", () => fs.readFileSync(file, []));
// The ENOENT message names the path, which carries the random temp dir, so
// this one compares the code and syscall alone.
try {
  fs.readFileSync(path.join(dir, "nope"), { encoding: "utf8", flag: "r" });
} catch (error) {
  console.log("missing", error.name, error.code, error.syscall);
}
show("directory", () => fs.readFileSync(dir, { encoding: "utf8" }));

fs.rmSync(dir, { recursive: true, force: true });
