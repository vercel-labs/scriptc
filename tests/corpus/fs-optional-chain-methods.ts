// Optional chains through the fs handle types: `x?.m(...)` on a nullable
// FileHandle, Dir, Dirent, FSWatcher, Stats, or BigIntStats guards the
// receiver and re-enters the handle's own member lowering with it narrowed
// (Lowerer.chainHandled). A nullish receiver short-circuits to undefined and
// leaves the handle untouched; readSync's `Dirent | null` keeps its null arm
// beside the chain's undefined one.
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "fs-optchain-"));
const file = path.join(root, "one.txt");
fs.writeFileSync(file, "hello");

function pickDir(dir: fs.Dir, present: boolean): fs.Dir | undefined {
  return present ? dir : undefined;
}
function pickDirent(dirent: fs.Dirent, present: boolean): fs.Dirent | undefined {
  return present ? dirent : undefined;
}
function pickWatcher(watcher: fs.FSWatcher, present: boolean): fs.FSWatcher | undefined {
  return present ? watcher : undefined;
}
function pickStats(stats: fs.Stats, present: boolean): fs.Stats | undefined {
  return present ? stats : undefined;
}
function pickBigStats(stats: fs.BigIntStats, present: boolean): fs.BigIntStats | undefined {
  return present ? stats : undefined;
}
function pickHandle(handle: fsp.FileHandle, present: boolean): fsp.FileHandle | undefined {
  return present ? handle : undefined;
}

async function dirChains(): Promise<void> {
  const dir = fs.opendirSync(root);
  // A nullish receiver answers undefined and consumes no entry, so the
  // guarded read that follows sees the directory's first entry.
  console.log("dir absent read:", pickDir(dir, false)?.readSync() === undefined);
  console.log("dir absent read again:", pickDir(dir, false)?.readSync() === undefined);
  const entry = pickDir(dir, true)?.readSync();
  console.log("dir first entry:", entry !== null && entry !== undefined && entry.name === "one.txt");
  console.log("dir path:", pickDir(dir, true)?.path === root);

  const dirent = pickDirent(entry!, true);
  console.log("dirent present:", dirent?.isFile(), dirent?.isDirectory(), dirent?.isSymbolicLink());
  console.log("dirent absent:", pickDirent(entry!, false)?.isFile());
  console.log("dir exhausted:", pickDir(dir, true)?.readSync() === null);
  pickDir(dir, false)?.closeSync();
  console.log("dir still open:", pickDir(dir, true)?.readSync() === null);
  pickDir(dir, true)?.closeSync();

  // Disposal is a Dir member too: the guarded element-access chain closes.
  const disposed = fs.opendirSync(root);
  pickDir(disposed, false)?.[Symbol.dispose]();
  console.log("dispose absent leaves it open:", pickDir(disposed, true)?.readSync() !== null);
  pickDir(disposed, true)?.[Symbol.dispose]();
  console.log("dir disposed");
}

async function handleChains(): Promise<void> {
  const handle = await fsp.open(file, "r");
  pickHandle(handle, false)?.close();
  // The absent close left the handle open; the present one closes it, and
  // a further close is Node's no-op rather than a second release.
  console.log("handle open after absent close:", (await handle.stat()).size);
  pickHandle(handle, true)?.close();
  pickHandle(handle, true)?.close();
  console.log("handle closed");
}

async function watcherChains(): Promise<void> {
  const watcher = fs.watch(file);
  pickWatcher(watcher, false)?.close();
  console.log("watcher absent close leaves it watching");
  pickWatcher(watcher, true)?.close();
  pickWatcher(watcher, true)?.close();
  console.log("watcher closed");
}

async function statsChains(): Promise<void> {
  const stats = fs.statSync(file);
  console.log("stats absent:", pickStats(stats, false)?.isFile());
  console.log("stats present:", pickStats(stats, true)?.isFile(), pickStats(stats, true)?.isDirectory());
  console.log("stats size:", pickStats(stats, true)?.size);

  const big = fs.statSync(file, { bigint: true });
  console.log("big absent:", pickBigStats(big, false)?.isFile());
  console.log("big present:", pickBigStats(big, true)?.isFile(), pickBigStats(big, true)?.size === 5n);
}

async function main(): Promise<void> {
  await dirChains();
  await handleChains();
  await watcherChains();
  await statsChains();
  fs.rmSync(root, { recursive: true, force: true });
  console.log("cleaned:", fs.existsSync(root));
}

void main();
