// fs.promises.opendir's Dir members: path, the promise and sync reads and
// closes, disposal, and for-await iteration, including the ERR_DIR_CLOSED
// errors a closed Dir reports, the auto-close at iteration end, and the
// concurrent-operation guard around a read in flight.
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { opendir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "fsp-dir-members-"));
writeFileSync(join(root, "a.txt"), "a");
mkdirSync(join(root, "b"));
symlinkSync(join(root, "a.txt"), join(root, "c"));
const all = "a.txt b c";

function report(label: string, error: unknown): void {
  const e = error as { name?: string; code?: string; message?: string };
  console.log(label, e.name, e.code, e.message);
}

async function main(): Promise<void> {
  const iterated = await opendir(root);
  console.log("path", iterated.path === root);
  const pairs: string[] = [];
  for await (const entry of iterated) pairs.push(`${entry.name}:${entry.parentPath === root}`);
  pairs.sort();
  console.log("iterated", pairs.join(" "));
  try {
    iterated.closeSync();
  } catch (error) {
    report("closeSync after iteration", error);
  }
  try {
    await iterated.close();
    console.log("close after iteration resolved");
  } catch (error) {
    report("close after iteration", error);
  }
  try {
    await iterated.read();
  } catch (error) {
    report("read after iteration", error);
  }
  try {
    iterated.readSync();
  } catch (error) {
    report("readSync after iteration", error);
  }
  await iterated[Symbol.asyncDispose]();
  console.log("asyncDispose after iteration resolved");

  const manual = await opendir(root);
  const named: string[] = [];
  for (let entry = await manual.read(); entry !== null; entry = await manual.read()) named.push(entry.name);
  named.sort();
  console.log("read", named.join(" "));
  console.log("end", (await manual.read()) === null);
  await manual.close();
  console.log("closed", manual.path === root);
  try {
    await manual.close();
  } catch (error) {
    report("close twice", error);
  }
  try {
    manual.closeSync();
  } catch (error) {
    report("closeSync after close", error);
  }

  const sync = await opendir(root);
  const first = sync.readSync();
  console.log("readSync", first !== null && first.name.length > 0);
  sync.closeSync();
  try {
    sync.readSync();
  } catch (error) {
    report("readSync after closeSync", error);
  }
  try {
    sync.closeSync();
  } catch (error) {
    report("closeSync twice", error);
  }

  const guarded = await opendir(root);
  const inFlight = guarded.read();
  try {
    guarded.readSync();
  } catch (error) {
    report("readSync during a read", error);
  }
  console.log("the read settles", (await inFlight) !== null);
  try {
    guarded.closeSync();
    console.log("closed after the guard");
  } catch (error) {
    report("close after the guard", error);
  }

  const disposed = await opendir(root);
  disposed[Symbol.dispose]();
  disposed[Symbol.dispose]();
  console.log("dispose twice returned");
  try {
    await disposed.read();
  } catch (error) {
    report("read after dispose", error);
  }

  const broken = await opendir(root);
  let seen = 0;
  for await (const entry of broken) {
    seen++;
    if (entry.name.length > 0) break;
  }
  console.log("break saw", seen);
  try {
    broken.readSync();
  } catch (error) {
    report("readSync after break", error);
  }

  const thrown = await opendir(root);
  try {
    for await (const entry of thrown) throw new Error(`stop at ${entry.parentPath === root}`);
  } catch (error) {
    console.log("thrown", (error as Error).message);
  }
  try {
    await thrown.close();
  } catch (error) {
    report("close after throw", error);
  }

  const mixed = await opendir(root);
  let got = 0;
  for (let i = 0; i < 4; i++) {
    const entry = i % 2 === 0 ? await mixed.read() : mixed.readSync();
    if (entry !== null) got++;
  }
  console.log("mixed reads", got);
  await mixed.close();

  const small = await opendir(root, { bufferSize: 1, encoding: "utf8" });
  const smallNames: string[] = [];
  for await (const entry of small) smallNames.push(entry.name);
  smallNames.sort();
  console.log("bufferSize 1", smallNames.join(" ") === all);

  rmSync(root, { recursive: true, force: true });
  console.log("removed", !existsSync(root));
}

void main();
