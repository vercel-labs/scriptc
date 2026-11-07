// An fs.Stats held at a structural type that names some of its members, directly, as a promise's
// payload, through function slots and in an unknown slot. It stays the Stats: its methods and
// members answer from the snapshot, and every view of one Stats is the same object.
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Kind {
  isDirectory(): boolean;
  isFile(): boolean;
}
interface Sized {
  size: number;
  isFile: () => boolean;
}
type Probe = (path: string) => Promise<Kind> | Kind;

const dir = mkdtempSync(join(tmpdir(), "view-"));
const file = join(dir, "data.txt");
writeFileSync(file, "12345");

function describe(kind: Kind): string {
  return `${kind.isDirectory() ? "dir" : "-"}${kind.isFile() ? "file" : "-"}`;
}

const dirStats = statSync(dir);
const fileStats = statSync(file);
const asKind: Kind = dirStats;
const asSized: Sized = fileStats;
console.log("direct", describe(asKind), describe(fileStats), asSized.size, asSized.isFile());
console.log("identity", (asKind as unknown) === dirStats, (asSized as unknown) === fileStats, (asKind as unknown) === fileStats);

// A literal of the same shape beside the Stats.
const fixed: Kind = { isDirectory: () => false, isFile: () => false };
const kinds: Kind[] = [asKind, fileStats, fixed];
console.log("list", kinds.map(describe).join(" "));

// An unknown slot: the members are read off the Stats itself.
const loose: any = fileStats;
console.log("unknown", loose.isFile(), loose.isDirectory(), loose.size, typeof loose.mtimeMs, loose.missing, loose === fileStats);
const members = ["dev", "mode", "nlink", "uid", "gid", "rdev", "blksize", "ino", "size", "blocks", "atimeMs", "mtimeMs", "ctimeMs", "birthtimeMs"];
console.log("members", members.map((name) => typeof loose[name]).join(" "));
console.log("dates", loose.mtime instanceof Date, loose.mtime.getTime() === fileStats.mtime.getTime());
console.log("tests", loose.isSymbolicLink(), loose.isFIFO(), loose.isSocket(), loose.isBlockDevice(), loose.isCharacterDevice());
try {
  loose.nothing();
} catch (error) {
  console.log("not a function", error instanceof TypeError);
}
const back = loose as Stats;
console.log("back", back === fileStats, back.size);

function statNow(path: string): Stats {
  return path === file ? fileStats : statSync(path);
}
async function statLater(path: string): Promise<Stats> {
  return stat(path);
}
function statEither(path: string): Promise<Stats> | Stats {
  return path === dir ? stat(path) : statSync(path);
}

async function main(): Promise<void> {
  const probes: [string, Probe][] = [
    ["now", statNow],
    ["later", statLater],
    ["either", statEither],
    ["literal", (path) => ({ isDirectory: () => path === dir, isFile: () => path === file })],
  ];
  for (const [name, probe] of probes) {
    console.log(name, describe(await probe(dir)), describe(await probe(file)));
    try {
      await probe(join(dir, "missing"));
      console.log(name, "no error");
    } catch (error) {
      console.log(name, "missing:", (error as { code?: string }).code);
    }
  }
  const viaSlot = await probes[0]![1](file);
  console.log("slot identity", (viaSlot as unknown) === fileStats);
  const pending: Promise<Sized> = stat(file);
  const settled = await pending;
  console.log("payload", settled.size, settled.isFile());
  rmSync(dir, { recursive: true });
}
main();
