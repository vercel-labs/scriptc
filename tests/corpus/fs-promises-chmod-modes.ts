// fsPromises.chmod mode spellings: parseFileMode takes a number in
// 0..2^32-1 or an octal string, and the checker also allows a stored union
// of the two. Node validates the path first and the mode second, so a
// missing file wins over a mode that would fail. lchmod has no Linux
// implementation: Node rejects with ERR_METHOD_NOT_IMPLEMENTED before it
// looks at either argument.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as fsp from "node:fs/promises";

process.umask(0o022);
const dir: string = fs.mkdtempSync(path.join(os.tmpdir(), "fsp-chmod-"));
const target: string = path.join(dir, "f.txt");

function clean(text: string): string {
  return text.split(dir).join("<dir>");
}

async function report(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    const value: unknown = await run();
    console.log(label, "ok", value === undefined ? "undefined" : String(value));
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    console.log(label, "threw", err.name, err.code, clean(err.message));
  }
}

/** The permission bits the chmod calls left on the file. */
function perms(): string {
  return (fs.statSync(target).mode & 0o777).toString(8);
}

async function main(): Promise<void> {
  fs.writeFileSync(target, "x");

  await fsp.chmod(target, 0o600);
  console.log("number", perms());
  await fsp.chmod(target, "644");
  console.log("octal string", perms());

  // A stored union: the mode is a number or an octal string at run time.
  const octalUnion: number | string = "640";
  await fsp.chmod(target, octalUnion);
  console.log("stored octal", perms());
  const numberUnion: number | string = 0o604;
  await fsp.chmod(target, numberUnion);
  console.log("stored number", perms());

  // The path is validated before the mode.
  const missing: string = path.join(dir, "nope");
  await report("missing octal", () => fsp.chmod(missing, "644"));
  await report("missing number", () => fsp.chmod(missing, 0o644));

  // lchmod: the stub rejects before validating either argument.
  await report("lchmod octal", () => fsp.lchmod(target, "644"));
  await report("lchmod number", () => fsp.lchmod(target, 0o644));
  const lchmodUnion: number | string = 0o644;
  await report("lchmod union", () => fsp.lchmod(target, lchmodUnion));
  await report("lchmod missing", () => fsp.lchmod(missing, 0o644));

  fs.rmSync(dir, { recursive: true, force: true });
}

await main();
