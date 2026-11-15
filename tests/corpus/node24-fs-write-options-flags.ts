import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = fs.mkdtempSync(join(tmpdir(), "scriptc-write-flags-"));
const under = (name: string): string => join(root, name);
const perm = (path: string): number => fs.statSync(path).mode & 0o777;
const read = (name: string): string => fs.readFileSync(under(name), "utf8");

function show(label: string, run: () => unknown): void {
  try {
    const value = run();
    console.log(label, "ok", value === undefined ? "undefined" : String(value));
  } catch (error) {
    const e = error as { name?: string; code?: string; message?: string };
    console.log(label, e.name, e.code, String(e.message).replace(root, "<root>"));
  }
}

// A flag may be open(2) bits rather than a name; the form's default still
// fills a falsy value, exactly Node's `options.flag || "w"`.
const W = fs.constants.O_WRONLY;
const WC = W | fs.constants.O_CREAT | fs.constants.O_TRUNC;
const WA = W | fs.constants.O_CREAT | fs.constants.O_APPEND;
const WX = W | fs.constants.O_CREAT | fs.constants.O_EXCL;
fs.writeFileSync(under("bits.txt"), "seed");
show("numeric truncate", () => fs.writeFileSync(under("bits.txt"), "a", { flag: WC }));
console.log("numeric truncate contents", read("bits.txt"));
show("numeric append", () => fs.writeFileSync(under("bits.txt"), "b", { flag: WA }));
console.log("numeric append contents", read("bits.txt"));
show("append numeric append", () => fs.appendFileSync(under("bits.txt"), "c", { flag: WA }));
console.log("append numeric contents", read("bits.txt"));
show("append numeric truncate", () => fs.appendFileSync(under("bits.txt"), "d", { flag: WC }));
console.log("append truncate contents", read("bits.txt"));
show("exclusive create", () => fs.writeFileSync(under("exclusive.txt"), "e", { flag: WX }));
show("exclusive again", () => fs.writeFileSync(under("exclusive.txt"), "f", { flag: WX }));

// The creation mode keeps Node's ladder whichever spelling of the flag the
// record carries, and applies at CREATION only.
show("numeric flag and mode", () =>
  fs.writeFileSync(under("mode.txt"), "m", { mode: 0o600, flag: WC }),
);
console.log("numeric flag mode bits", perm(under("mode.txt")));
show("numeric flag and octal mode", () =>
  fs.writeFileSync(under("octal-mode.txt"), "m", { mode: "640", flag: WC }),
);
console.log("numeric flag octal bits", perm(under("octal-mode.txt")));
show("numeric flag rewrites", () =>
  fs.writeFileSync(under("mode.txt"), "m", { mode: 0o777, flag: WC }),
);
console.log("numeric flag rewrite bits", perm(under("mode.txt")));

// Buffer data takes the same numeric flag; the encoding name is validated
// first even though the bytes are written as they are.
show("buffer numeric flag", () => fs.writeFileSync(under("buffer.bin"), Buffer.from("bb"), { flag: WC }));
console.log("buffer contents", read("buffer.bin"));
show("append buffer numeric flag", () =>
  fs.appendFileSync(under("buffer.bin"), Buffer.from("cc"), { flag: WA }),
);
console.log("append buffer contents", read("buffer.bin"));

// A flag whose static type the call site did not pin down runs
// stringToFlags at the call's run time: bits for a number, the name table
// for a string, and the form's default for a falsy value.
const dynamicFlag: number | string = WA;
show("dynamic numeric flag", () => fs.appendFileSync(under("dynamic.txt"), "a", { flag: dynamicFlag }));
console.log("dynamic numeric contents", read("dynamic.txt"));
const untypedFlag: any = "a";
show("untyped name flag", () => fs.appendFileSync(under("dynamic.txt"), "b", { flag: untypedFlag }));
console.log("untyped name contents", read("dynamic.txt"));
const untypedBits: any = WC;
show("untyped bits flag", () => fs.writeFileSync(under("dynamic.txt"), "c", { flag: untypedBits }));
console.log("untyped bits contents", read("dynamic.txt"));
const zeroFlag: any = 0;
show("zero flag", () => fs.writeFileSync(under("dynamic.txt"), "d", { flag: zeroFlag }));
console.log("zero flag contents", read("dynamic.txt"));
const nanFlag: any = NaN;
show("nan flag", () => fs.writeFileSync(under("dynamic.txt"), "e", { flag: nanFlag }));
console.log("nan flag contents", read("dynamic.txt"));
const emptyFlag: any = "";
show("empty flag", () => fs.appendFileSync(under("dynamic.txt"), "f", { flag: emptyFlag }));
console.log("empty flag contents", read("dynamic.txt"));
const nullFlag: any = null;
show("null flag", () => fs.writeFileSync(under("dynamic.txt"), "g", { flag: nullFlag }));
console.log("null flag contents", read("dynamic.txt"));
const undefinedFlag: number | undefined = undefined;
show("undefined flag", () => fs.appendFileSync(under("dynamic.txt"), "h", { flag: undefinedFlag }));
console.log("undefined flag contents", read("dynamic.txt"));
const dynamicMode: number | string = "600";
show("dynamic flag and mode", () =>
  fs.writeFileSync(under("dynamic-mode.txt"), "i", { mode: dynamicMode, flag: untypedBits }),
);
console.log("dynamic flag mode bits", perm(under("dynamic-mode.txt")));
show("dynamic mode with name flag", () =>
  fs.writeFileSync(under("dynamic-mode.txt"), "j", { mode: dynamicMode, flag: "a" }),
);
console.log("dynamic mode name contents", read("dynamic-mode.txt"));

// A data argument whose static type is a union still takes the numeric flag
// after the data kind is checked.
const mixed: string | Uint8Array = "text";
show("union data numeric flag", () => fs.writeFileSync(under("union.txt"), mixed, { flag: WC }));
console.log("union contents", read("union.txt"));

// stringToFlags' error shapes and Node's validation order (encoding, flag,
// mode, path). The last lines pin that a bad flag reports before the mode
// and before the path is touched.
show("fraction flag", () => fs.writeFileSync(under("bad.txt"), "a", { flag: 1.5 }));
show("range flag", () => fs.writeFileSync(under("bad.txt"), "a", { flag: 2147483648 }));
show("infinite flag", () => fs.writeFileSync(under("bad.txt"), "a", { flag: Infinity }));
show("unknown name", () => fs.writeFileSync(under("bad.txt"), "a", { flag: "bogus" }));
const boolFlag: any = true;
show("boolean flag", () => fs.writeFileSync(under("bad.txt"), "a", { flag: boolFlag }));
const badEncoding: any = "bogus";
show("bad encoding first", () =>
  fs.writeFileSync(under("bad.txt"), "a", { encoding: badEncoding, flag: 1.5 }),
);
show("bad flag before mode", () => fs.writeFileSync(under("bad.txt"), "a", { flag: "bogus", mode: -1 }));
show("bad flag before path", () => fs.writeFileSync(under("nope/bad.txt"), "a", { flag: "bogus" }));
show("append fraction flag", () => fs.appendFileSync(under("bad.txt"), "a", { flag: 1.5 }));
show("buffer fraction flag", () =>
  fs.writeFileSync(under("bad.txt"), Buffer.from("a"), { flag: 1.5 }),
);
console.log("no bad file", fs.existsSync(under("bad.txt")), fs.existsSync(under("nope")));

fs.rmSync(root, { recursive: true, force: true });
