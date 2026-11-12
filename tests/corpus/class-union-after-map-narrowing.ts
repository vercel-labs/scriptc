// A union of a Map and node classes (a directory held as a Map beside file
// and link nodes): after a guard rules the Map out, the remaining classes
// convert to their base, destructure, and take compound field assignments
// through it. instanceof answers false for the Map arm.
class Node {
  nlink = 1;
  mtimeMs = 0;
  readonly ino: number;
  constructor(ino: number) {
    this.ino = ino;
  }
}
class FileNode extends Node {
  size = 3;
}
class LinkNode extends Node {
  readonly target: string;
  constructor(ino: number, target: string) {
    super(ino);
    this.target = target;
  }
}
type Directory = Map<string, Entry>;
type Entry = Directory | FileNode | LinkNode;
const isDirectory = (entry: Entry | undefined): entry is Directory => entry instanceof Map;
const isFile = (entry: Entry | undefined): entry is FileNode => entry instanceof FileNode;

const root: Directory = new Map();
root.set("a", new FileNode(1));
root.set("b", new LinkNode(2, "a"));
root.set("d", new Map());
const seen = new Set<Node>();
let total = 0;
let files = 0;
for (const entry of root.values()) {
  if (isFile(entry)) files++;
  if (isDirectory(entry)) {
    total += 100;
    continue;
  }
  if (seen.has(entry)) continue;
  seen.add(entry);
  const { ino, nlink } = entry;
  entry.nlink += 1;
  total += ino + nlink + entry.nlink + entry.mtimeMs;
}
console.log(total, seen.size, files);
