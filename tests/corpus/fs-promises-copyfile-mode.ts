// fsPromises.copyFile mode: GetValidFileMode accepts null/undefined as 0,
// truncates a finite number toward zero and keeps its low bits as the
// COPYFILE_* flags (EXCL fails on an existing destination), while NaN and
// Infinity report "mode is out of range" and anything outside 0..&7 reports
// "mode is out of range: >= 0 && <= 7". Both paths are validated before the
// mode, and the mode before either path is opened.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fsp-copyfile-"));
const src = path.join(dir, "src.txt");
const dest = path.join(dir, "dest.txt");
fs.writeFileSync(src, "copied");

function clean(text: string): string {
  return text.split(dir).join("<dir>");
}

async function report(label: string, task: () => Promise<void>): Promise<void> {
  try {
    await task();
    console.log(label, "ok", fs.readFileSync(dest, "utf8"));
  } catch (error) {
    if (error instanceof Error) {
      const code = (error as NodeJS.ErrnoException).code;
      console.log(label, error.name, code, clean(error.message));
    } else {
      console.log(label, "non-error");
    }
  }
}

async function copyMode(mode: number): Promise<void> {
  await fsp.copyFile(src, dest, mode);
}

function maybeMode(excl: boolean): number | undefined {
  return excl ? fs.constants.COPYFILE_EXCL : undefined;
}

async function main(): Promise<void> {
  // Default and explicit 0 overwrite an existing destination.
  fs.writeFileSync(dest, "old");
  await report("default", () => fsp.copyFile(src, dest));
  fs.writeFileSync(dest, "old");
  await report("mode 0", () => copyMode(0));

  // COPYFILE_EXCL (1) fails on an existing destination; the other flag
  // combinations copy.
  fs.writeFileSync(dest, "old");
  await report("mode 1 existing", () => copyMode(1));
  await report("mode 3 existing", () => copyMode(3));
  await report("mode 5 existing", () => copyMode(5));
  await report("mode 7 existing", () => copyMode(7));
  for (const mode of [2, 4, 6]) {
    fs.writeFileSync(dest, "old");
    await report(`mode ${mode}`, () => copyMode(mode));
  }
  fs.rmSync(dest, { force: true });
  await report("mode 1 absent", () => copyMode(1));

  // A fractional mode truncates toward zero: 1.9 keeps EXCL, 2.7 does not.
  fs.writeFileSync(dest, "old");
  await report("mode 1.9 existing", () => copyMode(1.9));
  fs.writeFileSync(dest, "old");
  await report("mode 2.7 existing", () => copyMode(2.7));

  // An undefined mode means 0, whether the argument is written out or the
  // value arrives through a `number | undefined` variable.
  fs.writeFileSync(dest, "old");
  await report("mode undefined", () => fsp.copyFile(src, dest, undefined));
  fs.writeFileSync(dest, "old");
  await report("mode undefined variable", () => fsp.copyFile(src, dest, maybeMode(false)));
  fs.writeFileSync(dest, "old");
  await report("mode union excl", () => fsp.copyFile(src, dest, maybeMode(true)));

  // NaN and Infinity hold no int32 value; anything outside 0..7 does not
  // fit the COPYFILE_* flags.
  await report("mode NaN", () => copyMode(NaN));
  await report("mode Infinity", () => copyMode(Infinity));
  await report("mode -Infinity", () => copyMode(-Infinity));
  for (const mode of [8, -1, 4294967297, 1e21]) {
    await report(`mode ${mode}`, () => copyMode(mode));
  }

  // Validation order: src, then dest, then mode; the mode is checked
  // before either path is opened.
  await report("null byte src, bad mode", () => fsp.copyFile("a\0b", dest, 8));
  await report("null byte dest, bad mode", () => fsp.copyFile(src, "c\0d", 8));
  await report("null byte both", () => fsp.copyFile("a\0b", "c\0d", 0));
  await report("missing src, bad mode", () =>
    fsp.copyFile(path.join(dir, "missing.txt"), dest, 8));
  await report("missing src", () =>
    fsp.copyFile(path.join(dir, "missing.txt"), dest, 0));
  await report("missing dest dir", () =>
    fsp.copyFile(src, path.join(dir, "nodir", "file.txt"), 0));

  fs.rmSync(dir, { recursive: true, force: true });
}

main();
