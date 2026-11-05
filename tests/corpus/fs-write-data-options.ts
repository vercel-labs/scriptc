// The write family over string, Uint8Array, Buffer and DataView data: the
// options record's encoding, mode, flag and flush, the runtime validation
// order, and the append forms' own flag default. Everything the programs
// check is observable Node behaviour: the bytes on disk, the file modes,
// and the thrown errors' codes and messages.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scr-write-data-"));
const file = (name: string): string => path.join(dir, name);
const hex = (name: string): string => fs.readFileSync(file(name)).toString("hex");
const mode = (name: string): string => (fs.statSync(file(name)).mode & 0o777).toString(8);
// The names the runtime validates: '@types/node spells the encoding as
// BufferEncoding, so the runtime-checked values go through a cast.
const enc = (name: string): BufferEncoding => name as BufferEncoding;

const report = (label: string, e: unknown): void => {
  if (e instanceof Error) {
    console.log(label, e.name, (e as NodeJS.ErrnoException).code, e.message.split(dir).join("<dir>"));
  } else console.log(label, "non-error", String(e));
};

// String data under each spelling of the encoding option.
fs.writeFileSync(file("utf8.txt"), "héllo");
fs.writeFileSync(file("latin1.txt"), "héllo", { encoding: "latin1" });
fs.writeFileSync(file("hex.txt"), "68690a", { encoding: "hex" });
fs.writeFileSync(file("b64.txt"), "aGkK", { encoding: "base64" });
fs.writeFileSync(file("bare.txt"), "héllo", "latin1");
fs.writeFileSync(file("empty-enc.txt"), "plain", { encoding: enc("") });
console.log("strings:", hex("utf8.txt"), hex("latin1.txt"), hex("b64.txt"), hex("bare.txt"));
console.log("hex:", JSON.stringify(fs.readFileSync(file("hex.txt"), "utf8")));
console.log("empty:", fs.readFileSync(file("empty-enc.txt"), "utf8"));

// Byte data: the encoding is validated but never applied.
const buffer = Buffer.from([0, 1, 2, 250]);
fs.writeFileSync(file("buf.bin"), buffer);
fs.writeFileSync(file("buf-enc.bin"), buffer, { encoding: enc("buffer") });
const typed = new Uint8Array([9, 8, 7]);
fs.writeFileSync(file("typed.bin"), typed);
fs.writeFileSync(file("typed-enc.bin"), typed, { encoding: enc("base64") });
const view = new DataView(new Uint8Array([5, 6, 7, 8]).buffer, 1, 2);
fs.writeFileSync(file("view.bin"), view as unknown as Uint8Array);
console.log("bytes:", hex("buf.bin"), hex("buf-enc.bin"), hex("typed.bin"), hex("typed-enc.bin"));
console.log("view:", hex("view.bin"));

// The options record's values are evaluated in source order, before the
// write, exactly once.
const order: string[] = [];
const echo = <T>(label: string, value: T): T => {
  order.push(label);
  return value;
};
fs.writeFileSync(echo("path", file("order.txt")), echo("data", "ordered"), {
  flag: echo("flag", "w"),
  mode: echo("mode", 0o600),
  encoding: echo("encoding", "utf8"),
  flush: echo("flush", true),
});
console.log("order:", order.join(","), fs.readFileSync(file("order.txt"), "utf8"));
console.log("flush mode:", mode("order.txt"));

// The validation order: the encoding first, then the flush flag, then the
// path, the flag and the mode.
const nested = file("missing.txt");
try {
  fs.writeFileSync(file("x.txt"), "x", { encoding: enc("nope"), flag: "zz" });
} catch (e) {
  report("encoding-before-flag", e);
}
try {
  fs.writeFileSync(file("x.txt"), "x", { encoding: enc("buffer") });
} catch (e) {
  report("buffer-string-data", e);
}
try {
  fs.writeFileSync(file("\0nul.txt"), "x", { flag: "zz", mode: -1 });
} catch (e) {
  report("path-before-flag", e);
}
try {
  fs.writeFileSync(file("x.txt"), "x", { flag: "zz", mode: -1 });
} catch (e) {
  report("flag-before-mode", e);
}
try {
  fs.writeFileSync(file("x.txt"), "x", { mode: 1.5 });
} catch (e) {
  report("mode-integer", e);
}
try {
  fs.writeFileSync(file("x.txt"), "x", { mode: 4294967296 });
} catch (e) {
  report("mode-range", e);
}
try {
  fs.writeFileSync(nested, "x", { flag: "wx" });
} catch (e) {
  report("missing-wx", e);
}

// Flags: "wx" refuses an existing path, "r" opens read-only and the write
// fails against the descriptor, and an empty flag takes the default.
fs.writeFileSync(file("wx.txt"), "one", { flag: "wx" });
try {
  fs.writeFileSync(file("wx.txt"), "two", { flag: "wx" });
} catch (e) {
  report("wx-exists", e);
}
try {
  fs.writeFileSync(file("wx.txt"), "two", { flag: "r" });
} catch (e) {
  report("read-only", e);
}
fs.writeFileSync(file("wx.txt"), "three", { flag: "" });
console.log("flag-empty:", fs.readFileSync(file("wx.txt"), "utf8"));

// Modes apply at creation only.
fs.writeFileSync(file("mode.txt"), "created", { mode: 0o600 });
fs.writeFileSync(file("octal.txt"), "octal", { mode: "600" });
fs.writeFileSync(file("mode.txt"), "rewritten", { mode: 0o444 });
console.log("modes:", mode("mode.txt"), fs.readFileSync(file("mode.txt"), "utf8"), mode("octal.txt"));

// appendFile: "a" by default, and an empty flag stays "a".
fs.writeFileSync(file("app.txt"), "start-");
fs.appendFileSync(file("app.txt"), "one-", "latin1");
fs.appendFileSync(file("app.txt"), Buffer.from("two-"));
fs.appendFileSync(file("app.txt"), new Uint8Array([116, 104, 114, 101, 101]), {
  flag: "",
  encoding: enc("buffer"),
});
console.log("append:", fs.readFileSync(file("app.txt"), "utf8"));
try {
  fs.appendFileSync(file("app.txt"), "read-only", { flag: "r" });
} catch (e) {
  report("append-read-only", e);
}

// The string|Uint8Array union a shared helper carries selects the runtime
// entry from the live tag.
function writeEither(target: string, data: string | Uint8Array): void {
  fs.writeFileSync(target, data);
}
writeEither(file("either-str.txt"), "text");
writeEither(file("either-bytes.bin"), new Uint8Array([1, 2, 3]));
console.log("either:", fs.readFileSync(file("either-str.txt"), "utf8"), hex("either-bytes.bin"));

// fs/promises writeFile and appendFile run the same work and settle.
await fsp.writeFile(file("p.txt"), "promise", enc("latin1"));
await fsp.writeFile(file("p.bin"), new Uint8Array([4, 5]), {
  encoding: enc("buffer"),
  flush: true,
});
await fsp.appendFile(file("p.txt"), "-tail");
await fsp.appendFile(file("p.txt"), Buffer.from("-bytes"), { flag: "" });
console.log("promise:", fs.readFileSync(file("p.txt"), "utf8"), hex("p.bin"));

async function rejected(label: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    console.log(label, "resolved");
  } catch (e) {
    report(label, e);
  }
}
await rejected("promise-encoding", () =>
  fsp.writeFile(file("p.txt"), "x", { encoding: enc("nope") }),
);
await rejected("promise-flag", () => fsp.writeFile(file("p.txt"), "x", { flag: "zz" }));
await rejected("promise-mode", () => fsp.writeFile(file("p.txt"), "x", { mode: -1 }));
await rejected("promise-missing", () =>
  fsp.writeFile(path.join(dir, "absent", "x.txt"), "x", { encoding: enc("buffer") }),
);
await rejected("promise-buffer-string", () =>
  fsp.writeFile(file("p.txt"), "x", enc("buffer")),
);
await fsp.appendFile(file("p-flag.txt"), "a", { flag: "wx" });
await rejected("promise-append-exists", () =>
  fsp.appendFile(file("p-flag.txt"), "b", { flag: "wx" }),
);
console.log("promise-append:", fs.readFileSync(file("p-flag.txt"), "utf8"));

fs.rmSync(dir, { recursive: true, force: true });
console.log("removed:", !fs.existsSync(dir));
