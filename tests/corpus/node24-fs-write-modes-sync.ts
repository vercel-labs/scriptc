import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = fs.mkdtempSync(join(tmpdir(), "scriptc-write-modes-"));
const under = (name: string): string => join(root, name);
const perm = (path: string): number => fs.statSync(path).mode & 0o777;

function show(label: string, run: () => unknown): void {
  try {
    const value = run();
    console.log(label, "ok", value === undefined ? "undefined" : String(value));
  } catch (error) {
    const e = error as { name?: string; code?: string; message?: string };
    console.log(label, e.name, e.code, String(e.message).replace(root, "<root>"));
  }
}

// The creation mode of the options write takes a number or an octal string;
// it applies at CREATION only, so a later write keeps the bits.
show("write string mode", () => fs.writeFileSync(under("string.txt"), "a", { mode: "600" }));
console.log("write string bits", perm(under("string.txt")));
show("write number mode", () => fs.writeFileSync(under("number.txt"), "a", { mode: 0o604 }));
console.log("write number bits", perm(under("number.txt")));
show("write again", () => fs.writeFileSync(under("string.txt"), "b", { mode: 0o777 }));
console.log("write again bits", perm(under("string.txt")));
show("append string mode", () => fs.appendFileSync(under("append.txt"), "a", { mode: "640" }));
console.log("append string bits", perm(under("append.txt")));
console.log("append contents", fs.readFileSync(under("append.txt"), "utf8"));

// A value the call site did not pin down runs parseFileMode's ladder at the
// call's run time: an octal string, an untyped value, or undefined (0o666).
const dynamicMode: number | string = "750";
show("dynamic string mode", () => fs.writeFileSync(under("dynamic.txt"), "a", { mode: dynamicMode }));
console.log("dynamic string bits", perm(under("dynamic.txt")));
const untypedMode: any = "705";
show("untyped mode", () => fs.writeFileSync(under("untyped.txt"), "a", { mode: untypedMode }));
console.log("untyped bits", perm(under("untyped.txt")));
const maybeMode: number | undefined = undefined;
show("undefined mode", () => fs.writeFileSync(under("undefined.txt"), "a", { mode: maybeMode }));
console.log("undefined bits", perm(under("undefined.txt")));
const nullMode: any = null;
show("null mode", () => fs.writeFileSync(under("null.txt"), "a", { mode: nullMode }));
console.log("null bits", perm(under("null.txt")));

// Buffer data takes the same mode ladder; the encoding name is validated
// first even though the bytes are written as they are.
show("buffer string mode", () => fs.writeFileSync(under("buffer.txt"), Buffer.from("a"), { mode: "600" }));
console.log("buffer bits", perm(under("buffer.txt")));
show("append buffer string mode", () =>
  fs.appendFileSync(under("append-buffer.txt"), Buffer.from("a"), { mode: "640" }),
);
console.log("append buffer bits", perm(under("append-buffer.txt")));
console.log("append buffer contents", fs.readFileSync(under("append-buffer.txt"), "utf8"));

// A data argument whose static type is not a string or a u8 view still takes
// the mode ladder after the data kind is checked.
const mixed: string | Uint8Array = "text";
show("union data string mode", () => fs.writeFileSync(under("union.txt"), mixed, { mode: "604" }));
console.log("union bits", perm(under("union.txt")));
const view = new DataView(new Uint8Array([98]).buffer);
show("view data string mode", () => fs.appendFileSync(under("view.txt"), view, { mode: "640" }));
console.log("view bits", perm(under("view.txt")));
const untypedData: any = new Uint16Array([0x6261]);
show("untyped data mode", () => fs.writeFileSync(under("untyped-data.txt"), untypedData, { mode: dynamicMode }));
console.log("untyped data bits", perm(under("untyped-data.txt")));

// parseFileMode's error shapes, in Node's order (encoding, flag, mode,
// path) — the last line pins that a bad mode reports before the path.
show("bad octal", () => fs.writeFileSync(under("bad.txt"), "a", { mode: "999" }));
show("octal overflow", () => fs.writeFileSync(under("bad.txt"), "a", { mode: "77777777777777" }));
show("range", () => fs.writeFileSync(under("bad.txt"), "a", { mode: 4294967296 }));
show("negative", () => fs.writeFileSync(under("bad.txt"), "a", { mode: -1 }));
show("fraction", () => fs.writeFileSync(under("bad.txt"), "a", { mode: 1.5 }));
const boolMode: any = true;
show("boolean mode", () => fs.writeFileSync(under("bad.txt"), "a", { mode: boolMode }));
const objectMode: any = {};
show("object mode", () => fs.writeFileSync(under("bad.txt"), "a", { mode: objectMode }));
const badEncoding: any = "bogus";
show("bad encoding first", () =>
  fs.writeFileSync(under("bad.txt"), "a", { encoding: badEncoding, mode: -1 }),
);
show("bad flag first", () => fs.writeFileSync(under("bad.txt"), "a", { flag: "bogus", mode: -1 }));
show("missing path and bad mode", () => fs.writeFileSync(under("nope/bad.txt"), "a", { mode: -1 }));
show("append bad octal", () => fs.appendFileSync(under("bad.txt"), "a", { mode: "999" }));
show("buffer bad mode", () => fs.writeFileSync(under("bad.txt"), Buffer.from("a"), { mode: "999" }));
console.log("no bad file", fs.existsSync(under("bad.txt")), fs.existsSync(under("nope")));

fs.rmSync(root, { recursive: true, force: true });
