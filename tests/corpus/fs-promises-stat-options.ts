// fsPromises.stat/lstat options: { bigint } selects the BigIntStats member
// table, and stat's { throwIfNoEntry: false } fulfills with undefined for a
// missing entry or missing parent instead of rejecting. lstat reads only
// bigint — Node's promise binding ignores throwIfNoEntry there — and
// FileHandle.stat takes the same bigint flag on the open descriptor.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fsp-stat-"));
const file = path.join(dir, "f.txt");
const link = path.join(dir, "link.txt");
const missing = path.join(dir, "missing.txt");
const underFile = path.join(file, "child");

function clean(text: string): string {
  return text.split(dir).join("<dir>").replace(/t-[A-Za-z0-9]{6}-/g, "t-<name>-");
}

function report(label: string, error: unknown): void {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    console.log(label, error.name, code, clean(error.message));
  } else {
    console.log(label, "non-error");
  }
}

async function main(): Promise<void> {
  fs.writeFileSync(file, "0123456789");
  fs.symlinkSync(file, link);

  const plain = await fsp.stat(file);
  console.log("plain", typeof plain.size, plain.size, plain.isFile(), plain.isSymbolicLink());
  const big = await fsp.stat(file, { bigint: true });
  console.log("bigint", typeof big.size, big.size, big.isFile(), big.isSymbolicLink());
  const explicitlyPlain = await fsp.stat(file, { bigint: false });
  console.log("bigint false", typeof explicitlyPlain.size);
  const undefinedOptions = await fsp.stat(file, undefined);
  console.log("undefined options", typeof undefinedOptions.size);
  const throwing = await fsp.stat(file, { throwIfNoEntry: true });
  console.log("throwIfNoEntry true", typeof throwing.size, throwing.size);

  // A missing entry: undefined with the flag false, ENOENT otherwise.
  const absent = await fsp.stat(missing, { throwIfNoEntry: false });
  console.log("missing stat", absent === undefined);
  const absentBig = await fsp.stat(missing, { bigint: true, throwIfNoEntry: false });
  console.log("missing stat bigint", absentBig === undefined);
  const absentUnderFile = await fsp.stat(underFile, { throwIfNoEntry: false });
  console.log("missing parent", absentUnderFile === undefined);
  try {
    const answer = await fsp.stat(missing);
    console.log("missing stat throws", "fulfilled", answer.size);
  } catch (error) {
    report("missing stat throws", error);
  }
  try {
    const answer = await fsp.stat(missing, { bigint: true });
    console.log("missing stat bigint throws", "fulfilled", answer.size);
  } catch (error) {
    report("missing stat bigint throws", error);
  }

  // A stored record reads its flag at the call, like Node.
  const stored: { throwIfNoEntry: boolean } = { throwIfNoEntry: false };
  const storedAbsent = await fsp.stat(missing, stored);
  console.log("stored record", storedAbsent === undefined);
  const storedPresent = await fsp.stat(file, stored);
  console.log("stored record present", storedPresent?.size);

  // lstat: bigint selects the table; throwIfNoEntry is ignored.
  const lplain = await fsp.lstat(link);
  const lbig = await fsp.lstat(link, { bigint: true });
  console.log("lstat", lplain.isSymbolicLink(), typeof lbig.size, lbig.isSymbolicLink());
  try {
    const answer = await fsp.lstat(missing);
    console.log("lstat missing", "fulfilled", answer.size);
  } catch (error) {
    report("lstat missing", error);
  }
  try {
    const answer = await fsp.lstat(missing, { throwIfNoEntry: false });
    console.log("lstat missing flag", "fulfilled", answer.size);
  } catch (error) {
    report("lstat missing flag", error);
  }
  try {
    const answer = await fsp.lstat(missing, { bigint: true });
    console.log("lstat missing bigint", "fulfilled", answer.size);
  } catch (error) {
    report("lstat missing bigint", error);
  }

  // FileHandle.stat([options]) on the open descriptor.
  const handle = await fsp.open(file, "r");
  try {
    const hplain = await handle.stat();
    const hbig = await handle.stat({ bigint: true });
    const hexplicit = await handle.stat({ bigint: false });
    console.log("handle", typeof hplain.size, typeof hbig.size, typeof hexplicit.size, hbig.size);
  } finally {
    await handle.close();
  }
  try {
    const answer = await handle.stat({ bigint: true });
    console.log("handle closed", "fulfilled", answer.size);
  } catch (error) {
    report("handle closed", error);
  }

  const afterAwait = await fsp.stat(missing, { throwIfNoEntry: false });
  console.log("sync flag", afterAwait === undefined);
  await fsp.rm(dir, { recursive: true, force: true });
}

main();
