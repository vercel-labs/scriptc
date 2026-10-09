// Array callbacks may declare their element parameter as a structural
// supertype of the stored element (a reusable predicate over just the
// fields it reads). They still run statically whether or not the array is
// proven to hold only present elements, and find returns the stored
// element itself.
interface FileReference {
  pos: number;
  end: number;
  fileName: string;
}

const refs: FileReference[] = [
  { pos: 0, end: 5, fileName: "a" },
  { pos: 10, end: 20, fileName: "b" },
  { pos: 30, end: 40, fileName: "c" },
];

function findAt(position: number): FileReference | undefined {
  const inReference = (r: { pos: number; end: number }): boolean =>
    r.pos <= position && position <= r.end;
  return refs.find(inReference);
}
console.log(findAt(12)?.fileName, findAt(7)?.fileName, findAt(35) === refs[2]);

// Named callbacks over the supertype.
const late = (r: { pos: number }): boolean => r.pos > 5;
const span = (r: { pos: number; end: number }): number => r.end - r.pos;
function describe(r: { end: number }): string {
  return `end=${r.end}`;
}
console.log(refs.some(late), refs.every(late), refs.filter(late).length);
console.log(refs.map(span).join(","), refs.map(describe).join(" "));
console.log(refs.findIndex(late), refs.findLastIndex(late), refs.findLast(late)?.fileName);
console.log(refs.find(late) === refs[1], refs.filter(late)[0] === refs[1]);
refs.forEach((r: { fileName: string }) => console.log("named", r.fileName));
const logEnd = (r: { end: number }, index: number): void => console.log("end", index, r.end);
refs.forEach(logEnd);

// Inline callbacks over the supertype.
console.log(
  refs.some((r: { pos: number }) => r.pos > 25),
  refs.every((r: { end: number }) => r.end > 1),
  refs.filter((r: { pos: number }) => r.pos >= 10).map((r) => r.fileName).join(""),
);
console.log(
  refs.map((r: { pos: number; end: number }) => r.pos + r.end).join(","),
  refs.findIndex((r: { end: number }) => r.end === 40),
  refs.find((r: { pos: number }) => r.pos === 10)?.fileName,
);
console.log(
  refs.flatMap((r: { pos: number; end: number }) => [r.pos, r.end]).join(","),
  refs.reduce((total: number, r: { pos: number }) => total + r.pos, 0),
);

// Elements of a union, viewed through the fields every arm shares.
interface Added {
  kind: "added";
  pos: number;
  text: string;
}
interface Removed {
  kind: "removed";
  pos: number;
  count: number;
}
const edits: (Added | Removed)[] = [
  { kind: "added", pos: 3, text: "x" },
  { kind: "removed", pos: 8, count: 2 },
];
console.log(
  edits.some((e: { pos: number }) => e.pos > 5),
  edits.map((e: { kind: string; pos: number }) => `${e.kind}@${e.pos}`).join(" "),
  edits.findIndex(late),
);

// An array that may hold an explicit undefined keeps optional elements;
// a supertype callback that accepts undefined sees it, while one shared
// with a dense array still sees only present elements there.
const maybe: FileReference[] = [{ pos: 2, end: 3, fileName: "m" }];
maybe.push(refs[9]);
const wide = (r: { pos: number } | undefined): boolean => r !== undefined && r.pos > 1;
console.log(maybe.map(wide).join(","), maybe.filter(wide).length, refs.filter(wide).length);
console.log(maybe.findIndex((r: { pos: number } | undefined) => r === undefined));
maybe.forEach((r: { fileName: string } | undefined, index) =>
  console.log("maybe", index, r === undefined ? "<none>" : r.fileName),
);

// The find family visits holes as undefined.
const sparse: FileReference[] = [];
sparse[2] = { pos: 50, end: 60, fileName: "s" };
console.log(
  sparse.findIndex((r: { pos: number } | undefined) => r === undefined),
  sparse.find((r: { pos: number } | undefined) => r !== undefined && r.pos === 50)?.fileName,
  sparse.some(late),
);
