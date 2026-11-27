export {};
// A union that holds a Map beside node classes: `instanceof` on the union,
// a type-guard `continue` that rules the Map out, the narrowed read passed
// to a Set<Node>, destructuring through the narrowed class union, and a
// compound write to a field its arms' common base declares.
class Node {
  ino: number = 0;
  nlink: number = 0;
}

class FileNode extends Node {
  size: number = 1;
}

class LinkNode extends Node {
  target: string = "link";
}

type Entry = Map<string, Entry> | FileNode | LinkNode;

function isDirectory(entry: Entry): entry is Map<string, Entry> {
  return entry instanceof Map;
}

const entries = new Map<string, Entry>();
entries.set("file", new FileNode());
entries.set("link", new LinkNode());
entries.set("dir", new Map<string, Entry>());

const seen = new Set<Node>();
for (const entry of entries.values()) {
  if (isDirectory(entry)) continue;
  const kind = entry instanceof FileNode ? "file" : "link";
  seen.add(entry);
  const { ino, nlink } = entry;
  entry.nlink += 1;
  console.log(kind, ino, nlink, entry.nlink, seen.size);
}
console.log("seen", seen.size);
