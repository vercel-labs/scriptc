// fsPromises.open flags and mode: Node's stringToFlags takes a flag name or
// an int32 mask (an absent value answers "r"), parseFileMode takes a number
// or an octal string (an absent value answers 0o666), and the path is
// validated before the flags, the flags before the mode.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

process.umask(0o022);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fsp-open-"));
const file = path.join(dir, "file.txt");
fs.writeFileSync(file, "hello");

function clean(text: string): string {
  return text.split(dir).join("<dir>");
}

function report(label: string, error: unknown): void {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    console.log(label, error.name, code, clean(error.message));
  } else {
    console.log(label, "non-error");
  }
}

function perms(target: string): number {
  return fs.statSync(target).mode & 0o777;
}

async function main(): Promise<void> {
  // A numeric flag mask behaves exactly like its flag name.
  const readNumeric = await fsp.open(file, fs.constants.O_RDONLY);
  console.log("read numeric", await readNumeric.readFile("utf8"));
  await readNumeric.close();
  const readPlusNumeric = await fsp.open(file, fs.constants.O_RDWR);
  console.log("rdwr numeric", await readPlusNumeric.readFile("utf8"));
  await readPlusNumeric.close();

  // An explicitly absent flags value answers "r".
  const defaulted = await fsp.open(file, undefined);
  console.log("undefined flags", await defaulted.readFile("utf8"));
  await defaulted.close();

  // The creation mode accepts the numeric and the octal-string spelling and
  // applies under the umask only when the file is created.
  const octal = await fsp.open(path.join(dir, "octal"), "w", "600");
  console.log("octal mode", perms(path.join(dir, "octal")));
  await octal.close();
  const numericMode = await fsp.open(path.join(dir, "numeric-mode"), "w", 0o640);
  console.log("numeric mode", perms(path.join(dir, "numeric-mode")));
  await numericMode.close();
  const both = await fsp.open(
    path.join(dir, "both"),
    fs.constants.O_WRONLY | fs.constants.O_CREAT,
    "640",
  );
  console.log("numeric flags octal mode", perms(path.join(dir, "both")));
  await both.close();

  // The documented flags type is `string | number`: a value of that type is
  // read at run time, like Node.
  function openWith(flags: string | number): Promise<fsp.FileHandle> {
    return fsp.open(file, flags);
  }
  const unionString = await openWith("r");
  console.log("union string", await unionString.readFile("utf8"));
  await unionString.close();
  const unionNumber = await openWith(fs.constants.O_RDONLY);
  console.log("union number", await unionNumber.readFile("utf8"));
  await unionNumber.close();

  // So is a flags value that may be absent, and a mode of either kind.
  function openMaybe(flags: string | undefined, mode: number | string | undefined) {
    return fsp.open(path.join(dir, "maybe"), flags, mode);
  }
  const maybeAbsent = await openMaybe("a", undefined);
  console.log("absent mode", perms(path.join(dir, "maybe")));
  await maybeAbsent.close();
  const maybeString = await openMaybe(undefined, "600");
  console.log("absent flags oct mode", perms(path.join(dir, "maybe")));
  await maybeString.close();
  function openNumbers(flags: number, mode: number) {
    return fsp.open(path.join(dir, "numbers"), flags, mode);
  }
  const numbers = await openNumbers(
    fs.constants.O_WRONLY | fs.constants.O_CREAT,
    0o640,
  );
  console.log("numeric pair", perms(path.join(dir, "numbers")));
  await numbers.close();
  const absentValue: string | undefined = process.argv.length > 0 ? undefined : "r";
  const absentFlags = await fsp.open(file, absentValue);
  console.log("absent value flags", await absentFlags.readFile("utf8"));
  await absentFlags.close();

  // The numeric flag ladder is validateInt32's.
  try {
    await fsp.open(file, 1.5);
  } catch (error) {
    report("fractional flags", error);
  }
  try {
    await fsp.open(file, 4294967296);
  } catch (error) {
    report("large flags", error);
  }
  try {
    await fsp.open(file, -2147483649);
  } catch (error) {
    report("small flags", error);
  }
  try {
    await fsp.open(file, NaN);
  } catch (error) {
    report("nan flags", error);
  }
  try {
    await fsp.open(file, Infinity);
  } catch (error) {
    report("infinite flags", error);
  }
  try {
    await fsp.open(file, "bogus");
  } catch (error) {
    report("bogus flags", error);
  }

  // The mode ladder is parseFileMode's, in Node's order after the flags.
  try {
    await fsp.open(file, "bogus", "9x9");
  } catch (error) {
    report("flags before mode", error);
  }
  // A null-byte path is rejected before either option is read.
  try {
    await fsp.open("\0bad", 1.5);
  } catch (error) {
    report("path before flags", error);
  }
  try {
    await fsp.open(file, "r", "9x9");
  } catch (error) {
    report("bad octal", error);
  }
  try {
    await fsp.open(file, "r", "");
  } catch (error) {
    report("empty octal", error);
  }
  try {
    await fsp.open(file, "r", "0o755");
  } catch (error) {
    report("prefixed octal", error);
  }
  try {
    await fsp.open(file, "r", "77777777777777777777777");
  } catch (error) {
    report("huge octal", error);
  }
  try {
    await fsp.open(file, "r", 1.5);
  } catch (error) {
    report("fractional mode", error);
  }
  try {
    await fsp.open(file, "r", -1);
  } catch (error) {
    report("negative mode", error);
  }
  try {
    await fsp.open(file, "r", 4294967296);
  } catch (error) {
    report("large mode", error);
  }

  // A valid form reaches open(2): an existing directory cannot be written.
  try {
    await fsp.open(dir, "w");
  } catch (error) {
    report("directory", error);
  }
  try {
    await fsp.open(path.join(dir, "missing"), "r");
  } catch (error) {
    report("missing", error);
  }

  fs.rmSync(dir, { recursive: true, force: true });
}

main();
