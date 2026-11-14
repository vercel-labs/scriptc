// Stored options values for fs.writeFileSync and fs.appendFileSync: records
// held in a const, built by a call (once), received as a parameter, with
// optional fields and the flag/mode/encoding ladders the runtime runs.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scriptc-stored-write-"));
const file = path.join(directory, "data.txt");
const show = (label: string, run: () => void): void => {
  try {
    run();
    console.log(label, "returned");
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    console.log(label, failure.name, failure.code, failure.message);
  }
};
try {
  const create = { mode: 0o640, encoding: "utf8" as const, flag: "w" as const };
  fs.writeFileSync(file, "one", create);
  console.log("created", fs.readFileSync(file, "utf8"), (fs.statSync(file).mode & 0o777).toString(8));

  // A mutable record is read at the call, not at its initializer: a field
  // assigned in between reaches the write, and only a file this call
  // creates takes the mode.
  const mutable = { mode: 0o600 };
  mutable.mode = 0o700;
  const created = path.join(directory, "created.txt");
  fs.writeFileSync(created, "m", mutable);
  console.log("mutated mode", (fs.statSync(created).mode & 0o777).toString(8));
  mutable.mode = 0o644;
  fs.writeFileSync(created, "m", mutable);
  console.log("existing keeps its mode", (fs.statSync(created).mode & 0o777).toString(8));

  const appendFlag = { flag: "a" as string };
  fs.appendFileSync(file, "+two", appendFlag);
  console.log("appended", fs.readFileSync(file, "utf8"));

  const latin = { encoding: "latin1" as BufferEncoding };
  fs.appendFileSync(file, "é", latin);
  console.log("latin1", fs.readFileSync(file, "latin1"), fs.readFileSync(file).toString("hex"));

  // A field's undefined arm answers the write's default.
  const optional: { encoding?: BufferEncoding; mode?: number } = {};
  fs.writeFileSync(file, "plain", optional);
  console.log("optional defaults", fs.readFileSync(file, "utf8"), (fs.statSync(file).mode & 0o777).toString(8));

  // A call's result is evaluated exactly once, at the call.
  let evaluations = 0;
  const make = (): { flag: string; mode: number } => {
    evaluations += 1;
    return { flag: "a", mode: 0o600 };
  };
  fs.writeFileSync(file, "!call", make());
  console.log("call options", evaluations, fs.readFileSync(file, "utf8"));

  const viaParameter = (options: { flag: string }): void => {
    fs.writeFileSync(file, "!param", options);
  };
  viaParameter({ flag: "w" });
  console.log("parameter options", fs.readFileSync(file, "utf8"));

  // A numeric flag is open(2) bits; the numeric mode runs validateUint32.
  const bits = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC;
  fs.writeFileSync(file, "bits", { flag: bits, mode: 0o600 });
  console.log("numeric flag", fs.readFileSync(file, "utf8"), (fs.statSync(file).mode & 0o777).toString(8));

  // An octal string mode parses base 8.
  const octal = { mode: "640" as string };
  fs.writeFileSync(file, "octal", octal);
  console.log("octal mode", (fs.statSync(file).mode & 0o777).toString(8));

  // Buffer data ignores the encoding name, but still has to be a valid one.
  const bufferEncoding = { encoding: "buffer" as BufferEncoding };
  fs.writeFileSync(file, Buffer.from("bytes"), bufferEncoding);
  console.log("buffer encoding with bytes", fs.readFileSync(file, "utf8"));

  // Errors the runtime's ladders report.
  const badEncoding = { encoding: "zzz" as BufferEncoding };
  show("bad encoding", () => fs.writeFileSync(file, "x", badEncoding));
  show("buffer encoding with string", () => fs.writeFileSync(file, "x", bufferEncoding));
  show("bad mode", () => fs.writeFileSync(file, "x", { mode: "zzz" as string }));
  show("bad flag", () => fs.writeFileSync(file, "x", { flag: "zz" as string }));
  show("mode out of range", () => fs.writeFileSync(file, "x", { mode: -1 }));
  show("mode fraction", () => fs.writeFileSync(file, "x", { mode: 1.5 }));
  show("both bad append", () => fs.appendFileSync(file, "x", { mode: "zzz" as string, flag: "zz" as string }));
  show("both bad write", () => fs.writeFileSync(file, "x", { mode: "zzz" as string, flag: "zz" as string }));
  show("leading zero mode", () => fs.writeFileSync(file, "x", { mode: "0o600" as string }));

  // The descriptor form writes at the descriptor's current offset and
  // leaves it open; the caller closes it.
  const fd = fs.openSync(file, "r+");
  fs.writeFileSync(fd, "AB");
  fs.writeFileSync(fd, Buffer.from("CD"));
  fs.closeSync(fd);
  console.log("descriptor write", fs.readFileSync(file, "utf8"));
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
