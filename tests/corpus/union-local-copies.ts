// Array reads held in locals and copied between them: `number | undefined`,
// `boolean | undefined` and `string | undefined` values copied by
// declarations and assignments, read back, and stored into arrays, with
// holes and present undefined values along the way.

function flips(perm: number[]): number {
  const pp = perm.slice();
  let count = 0;
  let p0 = pp[0];
  while (p0 !== 0 && p0 !== undefined) {
    count++;
    for (let i = 1, j = p0 - 1; i < j; i++, j--) {
      const t = pp[i];
      pp[i] = pp[j];
      pp[j] = t;
    }
    const t = pp[p0];
    pp[p0] = p0;
    p0 = t;
  }
  return count;
}

console.log(flips([3, 1, 2, 0]), flips([2, 0, 1, 3]), flips([0, 1, 2]));

// A hole read into a local, copied, and written back as present undefined.
const sparse: number[] = [];
sparse[0] = 1;
sparse[2] = 3;
const out: number[] = [];
for (let i = 0; i < 4; i++) {
  const read = sparse[i];
  let copy = read;
  if (i === 2) copy = sparse[0];
  out[i] = copy;
}
console.log(out.length, 1 in out, out[1], out[2], 3 in out, out[3]);

// The copy feeds an index and is written back at it.
const keys: number[] = [2];
keys[2] = 0;
const values: number[] = [10, 20, 30];
const picked: (number | undefined)[] = [];
for (let i = 0; i < keys.length; i++) {
  let k = keys[i];
  const again = k;
  k = again;
  if (k === undefined) {
    picked.push(k);
    continue;
  }
  picked.push(values[k]);
  values[k] = k;
}
console.log(picked, values);

// Boolean and string elements.
const flags: boolean[] = [true, false];
let flag = flags[1];
const flagCopy = flag;
flag = flags[5];
console.log(flagCopy, flag, typeof flag);

const names: string[] = ["ada"];
names[2] = "lin";
const renamed: string[] = [];
for (let i = 0; i < 3; i++) {
  const name = names[i];
  let held = name;
  if (held === undefined) held = names[0];
  renamed[2 - i] = held;
}
console.log(renamed.join("/"), renamed.length);

// A copy that escapes: returned, captured, or stored in an object.
function firstOr(list: number[], fallback: number): number | undefined {
  const head = list[0];
  const result = head;
  return result ?? fallback;
}
console.log(firstOr([], 7), firstOr([4], 7));

function captured(list: number[]): () => number | undefined {
  const head = list[1];
  const kept = head;
  return () => kept;
}
console.log(captured([1, 2])(), captured([1])());

const holder: { value: number | undefined } = { value: 0 };
const element = sparse[1];
const moved = element;
holder.value = moved;
console.log(holder.value, "value" in holder);

// Reference elements, exception regions, generators, async functions,
// closures over a copy, and nested arrays.
class Box { v: number; constructor(v: number) { this.v = v; } }
function chain(xs: Box[], n: number): string {
  let out = "";
  let cur = xs[0];
  for (let i = 0; i < n; i++) {
    const next = xs[(i * 7) % (xs.length + 2)];
    let held = next;
    if (held === undefined) held = cur;
    cur = held;
    out += cur === undefined ? "u" : String(cur.v);
    if (i % 5 === 4) xs.pop();
  }
  return out;
}
console.log(chain([new Box(1), new Box(2), new Box(3), new Box(4)], 12));

function strings(words: string[]): string[] {
  const res: string[] = [];
  let last = words[0];
  for (let i = 0; i < words.length + 2; i++) {
    const w = words[i];
    const copy = w;
    last = copy ?? last;
    res[i] = copy;
    try {
      if (i === 3) throw new Error("x" + last);
    } catch (e) {
      res.push((e as Error).message);
    } finally {
      last = words[i + 1];
    }
  }
  return res;
}
console.log(strings(["a", "bb", "ccc", "dddd"]));

function* gen(xs: number[]): Generator<number | undefined> {
  const a = xs[5];
  const b = a;
  yield b;
  const c = xs[0];
  let d = c;
  d = xs[9];
  yield d;
}
console.log([...gen([1, 2])]);

async function asy(xs: number[]): Promise<string> {
  const a = xs[1];
  const b = a;
  await null;
  const c = b;
  return String(c);
}
asy([4, 5]).then((v) => console.log(v));

function closures(xs: number[]): number[] {
  const fns: (() => number | undefined)[] = [];
  for (let i = 0; i < 3; i++) {
    const v = xs[i];
    let copy = v;
    fns.push(() => copy);
    copy = xs[i + 1];
  }
  return fns.map((f) => f() ?? -1);
}
console.log(closures([10, 20]));

function nested(grid: number[][]): number {
  let s = 0;
  for (let r = 0; r < 3; r++) {
    const row = grid[r];
    const rowCopy = row;
    if (rowCopy === undefined) continue;
    for (let c = 0; c < 3; c++) {
      const cell = rowCopy[c];
      let x = cell;
      x = x === undefined ? 100 : x;
      s += x;
    }
  }
  return s;
}
console.log(nested([[1, 2], [3]]));

// The index rebinds the receiver: the store goes to the array the receiver
// held before the index ran, as for any element assignment.
let target: number[] = [1, 2, 3];
const original = target;
const other: number[] = [7, 8, 9];
const keyed: number[] = [1];
const missing = sparse[1];
const kept = sparse[0];
target[(target = other, keyed[0])] = missing;
console.log(original, target === other, 1 in original, other);
target = original;
target[(target = other, keyed[0])] = kept;
console.log(original, other);
