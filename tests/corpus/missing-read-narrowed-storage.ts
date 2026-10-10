// A `T | undefined` slot assigned a missing read (an out-of-range
// typed-array or array read the checker types as `T`) holds undefined,
// even though TypeScript narrows later reads to `T`. Reads keep the stored
// value: printing shows undefined, arithmetic gives NaN, and a member read
// throws Node's TypeError. Class fields (through `obj.f` and `this.f`) and
// locals both follow it; a presence guard still narrows.
const base: number = process.argv.length;
const chars = new Uint16Array([5, 6]);
const nums: number[] = [7];
const far = base + 100;

function twice(n: number): number {
  return n * 2;
}

class Cursor {
  token: number | undefined = 0;
  peek(i: number): number {
    return chars[i];
  }
  advance(i: number): string {
    this.token = chars[i];
    return `${this.token} ${this.token === undefined} ${this.token + 1}`;
  }
}

function fields(i: number, label: string): void {
  const cursor = new Cursor();
  cursor.token = chars[i];
  console.log(label, "direct", cursor.token, cursor.token === undefined);
  console.log(label, "ops", cursor.token + 1, -cursor.token, cursor.token < 3, `${cursor.token}`);
  console.log(label, "defaults", cursor.token ?? "none", cursor.token || "falsy");
  console.log(label, "call", twice(cursor.token), [cursor.token]);
  cursor.token = cursor.peek(i);
  console.log(label, "method", cursor.token, typeof cursor.token);
  cursor.token = nums[i];
  console.log(label, "array", cursor.token, String(cursor.token));
  console.log(label, "this", cursor.advance(i));
  if (cursor.token !== undefined) console.log(label, "guarded", cursor.token * 2);
  else console.log(label, "guarded absent");
}
fields(far, "missing");
fields(0, "present");

function locals(i: number, label: string): void {
  let code: number | undefined = 0;
  code = chars[i];
  console.log(label, "local", code, code + 1, `${code}`, [code], twice(code));
  let late: number | undefined;
  late = nums[i];
  console.log(label, "late", late, late === undefined, late ?? "none");
  let branch: number | undefined = 1;
  if (base > 0) branch = chars[i];
  console.log(label, "branch", branch, typeof branch);
  if (code !== undefined) console.log(label, "local guarded", code * 3);
  const viaExpr = (code = chars[i]);
  console.log(label, "assign expr", viaExpr, code);
}
locals(far, "missing");
locals(1, "present");

class Node2 {
  v: number;
  constructor(v: number) {
    this.v = v;
  }
}
const pool: Node2[] = [new Node2(4)];

class Holder {
  node: Node2 | undefined = undefined;
}

function objects(i: number, label: string): void {
  const holder = new Holder();
  holder.node = pool[i];
  console.log(label, "object field", holder.node === undefined);
  try {
    console.log(label, "object member", holder.node.v);
  } catch (e) {
    console.log(label, "object member threw", (e as Error).name, (e as Error).message);
  }
  let current: Node2 | undefined = new Node2(1);
  current = pool[i];
  console.log(label, "object local", current === undefined);
}
objects(far, "missing");
objects(0, "present");
