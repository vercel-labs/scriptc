// With a weak collection in the program, every object type's free tells
// the collection to forget the key: objects built later at a freed key's
// address (the allocator reuses blocks of the same size) are not members.
class Node {
  id: number;
  constructor(id: number) {
    this.id = id;
  }
}
interface Tag {
  label: string;
}

const seenNodes = new WeakSet<Node>();
const seenTags = new WeakSet<Tag>();
const seenArrays = new WeakMap<number[], string>();
for (let i = 0; i < 64; i++) {
  seenNodes.add(new Node(i));
  seenTags.add({ label: "t" + i });
  seenArrays.set([i], "a" + i);
}
let hits = 0;
for (let i = 0; i < 64; i++) {
  if (seenNodes.has(new Node(i))) hits++;
  if (seenTags.has({ label: "t" + i })) hits++;
  if (seenArrays.has([i])) hits++;
}
console.log("stale hits", hits);

const kept = new Node(1);
const tag: Tag = { label: "kept" };
seenNodes.add(kept);
seenTags.add(tag);
console.log(seenNodes.has(kept), seenTags.has(tag));
seenNodes.delete(kept);
console.log(seenNodes.has(kept), seenTags.has(tag));

// Checked records with undeclared keys in the same program.
const parsed = JSON.parse('{"label":"x","more":1}') as Tag;
seenTags.add(parsed);
console.log(JSON.stringify(parsed), seenTags.has(parsed));
