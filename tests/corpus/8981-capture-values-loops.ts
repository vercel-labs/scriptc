// Loop bindings: every iteration has its own binding, and a closure keeps
// the one of the iteration that created it.
type Read = () => string;
const show = (reads: Read[]): string => reads.map((read) => read()).join(",");

// The counter is only stepped by the update clause.
function counted(n: number): string {
  const reads: Read[] = [];
  for (let i = 0; i < n; i++) reads.push(() => `i${i}`);
  for (let i = n, j = 0; i > 0; i -= 2, j++) reads.push(() => `${i}:${j}`);
  return show(reads);
}
console.log(counted(4));

// The body writes the counter after the closure exists: the closure sees
// the write, and the next iteration starts from it.
function writtenInBody(): string {
  const reads: Read[] = [];
  for (let i = 0; i < 10; i++) {
    reads.push(() => `w${i}`);
    if (i % 3 === 0) i += 2;
  }
  return show(reads);
}
console.log(writtenInBody());

// Closures created in the head: the initializer's sees the first binding,
// the condition's and the update's see the binding of their iteration.
function inHead(): string {
  const reads: Read[] = [];
  let first: Read = () => "unset";
  for (
    let i = 0, keep = (first = () => `first${i}`);
    reads.push(() => `c${i}`) < 9 && i < 3;
    reads.push(() => `u${i}`), i++
  ) {
    reads.push(() => `b${i}`);
    void keep;
  }
  return `${first()} ${show(reads)}`;
}
console.log(inHead());

// A closure written by a later iteration through a shared outer binding.
function sharedOuter(): string {
  const reads: Read[] = [];
  let total = 0;
  for (let i = 1; i <= 3; i++) {
    const square = i * i;
    total += square;
    reads.push(() => `${square}/${total}`);
  }
  return show(reads);
}
console.log(sharedOuter());

// for-of over arrays, strings, maps, sets, entries and a generator.
function* gen(limit: number): Generator<number> {
  for (let k = 0; k < limit; k++) yield k * k;
}
function iterated(): string {
  const reads: Read[] = [];
  for (const word of ["a", "b", "c"]) reads.push(() => word.toUpperCase());
  for (const ch of "xyz") reads.push(() => ch + ch);
  const ages = new Map<string, number>([
    ["ann", 31],
    ["bob", 27],
  ]);
  for (const [name, age] of ages) reads.push(() => `${name}=${age}`);
  for (const key of ages.keys()) reads.push(() => "key " + key);
  for (const member of new Set([true, false])) reads.push(() => String(member));
  for (const [index, value] of ["p", "q"].entries()) reads.push(() => `${index}${value}`);
  for (const squared of gen(4)) reads.push(() => `sq${squared}`);
  for (let item of [1, 2, 3]) {
    reads.push(() => `item${item}`);
    item *= 10;
  }
  const record: Record<string, number> = { one: 1, two: 2 };
  for (const key in record) reads.push(() => `${key}->${record[key]}`);
  return show(reads);
}
console.log(iterated());

// `var` in a loop is one binding for the whole function.
function hoistedVar(): string {
  const reads: Read[] = [];
  for (var v = 0; v < 3; v++) {
    var doubled = v * 2;
    reads.push(() => `${v}/${doubled}`);
  }
  return show(reads);
}
console.log(hoistedVar());

// while and do-while bodies, nested loops, labels, break and continue.
function nested(): string {
  const reads: Read[] = [];
  let outer = 0;
  rows: while (outer < 4) {
    const row = outer++;
    let column = 0;
    do {
      const cell = `${row}.${column}`;
      if (column === 2) continue rows;
      if (row === 3) break rows;
      reads.push(() => cell);
      column++;
    } while (column < 5);
  }
  for (let a = 0; a < 2; a++) {
    for (let b = 0; b < 2; b++) {
      const product = (a + 1) * (b + 1);
      reads.push(() => `${a}*${b}=${product}`);
    }
  }
  return show(reads);
}
console.log(nested());

// Closures created in a loop, called while the loop still runs and after.
function interleaved(): string {
  const log: string[] = [];
  let previous: Read = () => "start";
  for (let i = 0; i < 4; i++) {
    const tag = "t" + i;
    const before = previous;
    previous = () => `${tag}<${before()}`;
    log.push(previous());
  }
  return `${log.length} ${previous()}`;
}
console.log(interleaved());

// Many iterations: each closure owns its value until it is dropped.
function many(count: number): number {
  let sum = 0;
  const kept: (() => number)[] = [];
  for (let i = 0; i < count; i++) {
    const text = "n" + i;
    const size = (): number => text.length + i;
    if (i % 100 === 0) kept.push(size);
    sum += size();
  }
  for (const size of kept) sum += size();
  return sum;
}
console.log(many(5000));
