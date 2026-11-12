// fs.promises.readdir and opendir Dirents: name, parentPath and the seven
// entry-kind probes over a regular file, a directory, a symbolic link, a
// FIFO, character and block devices and a Unix socket, in the string and
// Buffer name encodings, through both listing forms.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { opendir, readdir } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "fsp-dirent-members-"));
writeFileSync(join(root, "file"), "");
mkdirSync(join(root, "dir"));
writeFileSync(join(root, "dir", "inner"), "");
symlinkSync(join(root, "file"), join(root, "link"));

const made = (command: string, args: string[]): boolean => spawnSync(command, args).status === 0;
console.log("fifo", made("mkfifo", [join(root, "fifo")]));
console.log("char device", made("mknod", [join(root, "chardev"), "c", "1", "3"]));
console.log("block device", made("mknod", [join(root, "blockdev"), "b", "7", "0"]));

// The probes are written once per name encoding: the compiler's Dirent
// record is interned per instantiation, so a structural interface parameter
// would not accept it.
function probes(entry: Dirent): string {
  return [
    entry.isFile() ? "file" : "-",
    entry.isDirectory() ? "dir" : "-",
    entry.isSymbolicLink() ? "link" : "-",
    entry.isFIFO() ? "fifo" : "-",
    entry.isSocket() ? "socket" : "-",
    entry.isCharacterDevice() ? "char" : "-",
    entry.isBlockDevice() ? "block" : "-",
  ].join(",");
}

function bufferProbes(entry: Dirent<Buffer>): string {
  return [
    entry.isFile() ? "file" : "-",
    entry.isDirectory() ? "dir" : "-",
    entry.isSymbolicLink() ? "link" : "-",
    entry.isFIFO() ? "fifo" : "-",
    entry.isSocket() ? "socket" : "-",
    entry.isCharacterDevice() ? "char" : "-",
    entry.isBlockDevice() ? "block" : "-",
  ].join(",");
}

const socketPath = join(root, "socket");
const server = net.createServer();
server.listen(socketPath, () => {
  void main();
});

async function main(): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  const rows = entries.map(
    (entry) => `${entry.name} keys=${Object.keys(entry).join("+")} parent=${entry.parentPath === root} ${probes(entry)}`,
  );
  rows.sort();
  for (const row of rows) console.log("dirent", row);

  const walked: string[] = [];
  const stream = await opendir(root);
  for await (const entry of stream) {
    walked.push(`${entry.name} parent=${entry.parentPath === root} ${probes(entry)}`);
  }
  walked.sort();
  for (const row of walked) console.log("opendir", row);

  const nested = await readdir(join(root, "dir"), { withFileTypes: true });
  console.log("nested", nested.length, nested.length === 1 ? nested[0]!.name : "-", nested.length === 1 ? nested[0]!.parentPath === join(root, "dir") : false);

  const buffers = await readdir(root, { encoding: "buffer", withFileTypes: true });
  const bufferRows = buffers.map(
    (entry) =>
      `${entry.name.toString("utf8")} name=${Buffer.isBuffer(entry.name)} parent=${typeof entry.parentPath} ${bufferProbes(entry)}`,
  );
  bufferRows.sort();
  for (const row of bufferRows) console.log("buffer", row);

  const explicit = await readdir(root, { encoding: "utf8", withFileTypes: true });
  console.log(
    "utf8",
    explicit.length,
    explicit.every((entry) => typeof entry.name === "string"),
    explicit.every((entry) => entry.parentPath === root),
  );

  server.close();
  rmSync(root, { recursive: true, force: true });
  console.log("removed", !existsSync(root));
}
