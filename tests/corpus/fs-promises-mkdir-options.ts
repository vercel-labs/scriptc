// fsPromises.mkdir options: the mode shorthand (a number or an octal
// string), the literal { recursive, mode } record, and the recursive
// answer — the first directory the walk created, or undefined when the
// path already existed. Node validates the path first and the mode second
// (parseFileMode), so that order decides which error wins.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// A known mask keeps the created permissions readable: each mode below
// has bits the mask does not clear.
process.umask(0o022);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fsp-mkdir-"));

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
  const deep = path.join(dir, "a", "b", "c");
  const first = await fsp.mkdir(deep, { recursive: true });
  console.log("first", first === path.join(dir, "a"), fs.existsSync(deep));
  console.log("again", (await fsp.mkdir(deep, { recursive: true })) === undefined);

  const part = path.join(dir, "p");
  await fsp.mkdir(part, { recursive: true });
  const inner = await fsp.mkdir(path.join(part, "q", "r"), { recursive: true });
  console.log("partial", inner === path.join(part, "q"));

  const plain = path.join(dir, "plain");
  await fsp.mkdir(plain);
  console.log("plain", fs.existsSync(plain));
  const explicitFalse = path.join(dir, "false");
  await fsp.mkdir(explicitFalse, { recursive: false });
  console.log("recursive false", fs.existsSync(explicitFalse));
  const nullOptions = path.join(dir, "null");
  await fsp.mkdir(nullOptions, null);
  console.log("null options", fs.existsSync(nullOptions));
  const undefinedOptions = path.join(dir, "undef");
  await fsp.mkdir(undefinedOptions, undefined);
  console.log("undefined options", fs.existsSync(undefinedOptions));
  const emptyOptions = path.join(dir, "empty");
  await fsp.mkdir(emptyOptions, {});
  console.log("empty options", fs.existsSync(emptyOptions));

  const numShorthand = path.join(dir, "num");
  await fsp.mkdir(numShorthand, 0o700);
  console.log("number shorthand", perms(numShorthand));
  const strShorthand = path.join(dir, "str");
  await fsp.mkdir(strShorthand, "750");
  console.log("octal shorthand", perms(strShorthand));
  const numMode = path.join(dir, "nummode");
  await fsp.mkdir(numMode, { mode: 0o710 });
  console.log("number mode", perms(numMode));
  const strMode = path.join(dir, "strmode");
  await fsp.mkdir(strMode, { mode: "705" });
  console.log("octal mode", perms(strMode));
  const variableMode = 0o711;
  const variable = path.join(dir, "variable");
  await fsp.mkdir(variable, { mode: variableMode });
  console.log("variable mode", perms(variable));
  const recursiveMode = await fsp.mkdir(path.join(dir, "m", "n"), {
    recursive: true,
    mode: "700",
  });
  console.log(
    "recursive mode",
    recursiveMode === path.join(dir, "m"),
    perms(recursiveMode ?? path.join(dir, "m")),
  );

  try {
    await fsp.mkdir(path.join(dir, "bad-octal"), "9x9");
    console.log("bad octal", "fulfilled");
  } catch (error) {
    report("bad octal", error);
  }
  try {
    await fsp.mkdir(path.join(dir, "bad-empty"), "");
    console.log("empty mode", "fulfilled");
  } catch (error) {
    report("empty mode", error);
  }
  try {
    await fsp.mkdir(path.join(dir, "bad-prefix"), "0o755");
    console.log("prefixed octal", "fulfilled");
  } catch (error) {
    report("prefixed octal", error);
  }
  try {
    await fsp.mkdir(path.join(dir, "frac"), { mode: 1.5 });
    console.log("fractional mode", "fulfilled");
  } catch (error) {
    report("fractional mode", error);
  }
  try {
    await fsp.mkdir(path.join(dir, "negative"), { mode: -1 });
    console.log("negative mode", "fulfilled");
  } catch (error) {
    report("negative mode", error);
  }
  try {
    await fsp.mkdir(path.join(dir, "huge"), { mode: 4294967296 });
    console.log("huge mode", "fulfilled");
  } catch (error) {
    report("huge mode", error);
  }
  try {
    await fsp.mkdir(path.join(dir, "recursive-bad"), { recursive: true, mode: "9x9" });
    console.log("recursive bad mode", "fulfilled", fs.existsSync(path.join(dir, "recursive-bad")));
  } catch (error) {
    report("recursive bad mode", error);
    console.log("recursive bad mode created", fs.existsSync(path.join(dir, "recursive-bad")));
  }
  // The path is validated before the mode, so a null-byte path wins.
  try {
    await fsp.mkdir("\0bad", "9x9");
    console.log("null byte path", "fulfilled");
  } catch (error) {
    report("null byte path", error);
  }
  // A valid mode reaches the syscall: the missing parent is ENOENT.
  try {
    await fsp.mkdir(path.join(dir, "no-parent", "child"), { mode: 0o700 });
    console.log("missing parent", "fulfilled");
  } catch (error) {
    report("missing parent", error);
  }

  fs.rmSync(dir, { recursive: true, force: true });
}

main();
