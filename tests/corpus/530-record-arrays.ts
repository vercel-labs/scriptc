// Arrays of records: literals, element get/set, push/pop, for-of, length,
// reference identity (===, indexOf/includes), and nested
// { title; entries: X[] }[] shapes — the real-CLI blocker family.
interface Job {
  id: number;
  name: string;
  done: boolean;
}

const jobs: Job[] = [
  { id: 1, name: "build", done: false },
  { id: 2, name: "test", done: false },
];
jobs.push({ id: 3, name: "ship", done: true });
console.log(jobs.length);

for (const j of jobs) {
  console.log(j.id, j.name, j.done);
}

// Element writes replace (and release) the old record.
jobs[1] = { id: 20, name: "retest", done: true };
console.log(jobs[1].name, jobs.length);

// Reads alias the SAME record — mutation through one reference is visible
// through the array (JS object semantics).
const first = jobs[0];
first.done = true;
console.log(jobs[0].done);

// Reference identity: === , indexOf, includes all compare pointers.
console.log(first === jobs[0]);
console.log(jobs.indexOf(first), jobs.includes(first));
const stranger: Job = { id: 1, name: "build", done: true };
console.log(jobs.indexOf(stranger), jobs.includes(stranger));

// pop transfers the element out.
const popped = jobs.pop();
console.log(popped?.name ?? "missing", jobs.length);

// Nested shapes: records holding record arrays, arrays of those.
interface Group {
  title: string;
  entries: Job[];
}
const groups: Group[] = [
  { title: "a", entries: [{ id: 10, name: "x", done: false }] },
  { title: "b", entries: [] },
];
groups[1].entries.push({ id: 11, name: "y", done: true });
groups[1].entries.push({ id: 12, name: "z", done: false });
for (const g of groups) {
  console.log(g.title, g.entries.length);
  for (const e of g.entries) {
    console.log(" ", e.id, e.name);
  }
}

// Arrays of record arrays (array elements that are themselves ref-element
// arrays).
const grid: Job[][] = [[{ id: 100, name: "deep", done: false }], []];
grid[1].push(grid[0][0]);
console.log(grid[0][0] === grid[1][0], grid[1][0].name);

// Class instances as elements.
class Point {
  x: number;
  y: number;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
  norm(): number {
    return this.x * this.x + this.y * this.y;
  }
}
const pts: Point[] = [new Point(1, 2), new Point(3, 4)];
pts.push(new Point(5, 6));
let total = 0;
for (const p of pts) total += p.norm();
console.log(total, pts.indexOf(pts[2]));
