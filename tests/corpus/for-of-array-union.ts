// for…of over a value whose type is a union of array types. Every arm is an
// array, so the loop is the one array walk whichever arm the value holds:
// the live length bounds it and each element reads through its own arm.

type Chunk = {
  type: string;
  text?: string;
  thinking?: Array<{ text?: string }>;
};
interface Delta {
  content?: string | Chunk[] | null;
}

// A conditional that wraps a lone string, leaving `string[] | Chunk[]`.
function consume(delta: Delta): string[] {
  const out: string[] = [];
  if (delta.content !== null && delta.content !== undefined) {
    const items = typeof delta.content === "string" ? [delta.content] : delta.content;
    for (const item of items) {
      if (typeof item === "string") {
        if (!item) continue;
        out.push("s:" + item);
        continue;
      }
      if (item.type === "text" && item.text) {
        out.push("t:" + item.text);
        continue;
      }
      if (item.type === "thinking" && item.thinking) {
        for (const part of item.thinking) {
          if (part.text) out.push("k:" + part.text);
        }
      }
    }
  }
  return out;
}

console.log(consume({ content: "hi" }).join(","));
console.log(consume({ content: "" }).length);
console.log(
  consume({
    content: [
      { type: "text", text: "a" },
      { type: "thinking", thinking: [{ text: "b" }, {}, { text: "c" }] },
      { type: "other" },
    ],
  }).join(","),
);
console.log(consume({}).length, consume({ content: null }).length, consume({ content: [] }).length);

// Two record arms told apart by a discriminant.
interface Circle {
  kind: "circle";
  r: number;
}
interface Square {
  kind: "square";
  side: number;
}
function shapes(round: boolean): Circle[] | Square[] {
  if (round)
    return [
      { kind: "circle", r: 1 },
      { kind: "circle", r: 2 },
    ];
  return [{ kind: "square", side: 3 }];
}
function area(list: Circle[] | Square[]): number {
  let total = 0;
  for (const shape of list) {
    total += shape.kind === "circle" ? 3 * shape.r * shape.r : shape.side * shape.side;
  }
  return total;
}
console.log(area(shapes(true)), area(shapes(false)));

// Three arms, primitives of different kinds; the head runs once.
let calls = 0;
function pick(which: number): number[] | string[] | boolean[] {
  calls++;
  if (which === 0) return [1, 2, 3];
  if (which === 1) return ["x", "yy"];
  return [true, false, true, true];
}
for (let which = 0; which < 3; which++) {
  const seen: string[] = [];
  for (const value of pick(which)) {
    seen.push(typeof value === "number" ? `n${value + 1}` : typeof value === "string" ? `s${value.length}` : `b${value}`);
  }
  console.log(seen.join(" "));
}
console.log("calls", calls);

// The length is live: an element pushed during the walk is visited.
const grown: string[] = ["a"];
function liveList(text: boolean): string[] | number[] {
  if (text) return grown;
  return [0];
}
let visits = 0;
for (const entry of liveList(calls > 0)) {
  visits++;
  if (grown.length < 4) grown.push(`${entry}${grown.length}`);
}
console.log(visits, grown.join(","));

// break, continue and a labeled exit; return from inside the loop.
function firstLong(list: string[] | number[], floor: number): string {
  for (const entry of list) {
    if (typeof entry === "number") {
      if (entry < floor) continue;
      return `n:${entry}`;
    }
    if (entry.length >= floor) return `s:${entry}`;
  }
  return "none";
}
console.log(firstLong([1, 5, 9], 4), firstLong(["a", "abcd", "abcdef"], 3), firstLong(["a"], 3), firstLong([], 1));

function grid(rows: number[] | string[], cols: string[] | number[]): string {
  const cells: string[] = [];
  outer: for (const row of rows) {
    for (const col of cols) {
      if (col === "skip") continue outer;
      if (row === 3) break outer;
      cells.push(`${row}${col}`);
    }
  }
  return cells.join(" ");
}
console.log(grid([1, 2, 3, 4], ["a", "b"]));
console.log(grid(["x", "y"], [7, 8]));
console.log(grid([1, 2], ["a", "skip", "b"]));

// An optional member narrowed by a guard, and a pre-declared loop variable.
interface Batch {
  ids?: number[] | string[];
}
function describe(batch: Batch): string {
  if (!batch.ids) return "no ids";
  let last: number | string = "";
  let count = 0;
  for (last of batch.ids) count++;
  return `${count} ids, last ${last}`;
}
console.log(describe({}), "|", describe({ ids: [4, 5] }), "|", describe({ ids: ["p", "q", "r"] }));

// Arms whose elements may themselves be undefined, and holes: a write past
// the end leaves holes between the old length and the index.
function sparse(text: boolean): (string | undefined)[] | number[] {
  if (text) return ["a", undefined, "c"];
  const numbers: number[] = [1];
  numbers[3] = 4;
  return numbers;
}
for (const text of [true, false]) {
  const parts: string[] = [];
  for (const entry of sparse(text)) parts.push(entry === undefined ? "_" : String(entry));
  console.log(parts.join(""));
}

// Destructuring the loop variable, with closures capturing each binding.
type Named = { name: string; rank: number };
type Tagged = { name: string; tag: string };
function names(list: Named[] | Tagged[]): string {
  const thunks: Array<() => string> = [];
  for (const { name } of list) thunks.push(() => name.toUpperCase());
  return thunks.map((thunk) => thunk()).join("+");
}
console.log(
  names([
    { name: "a", rank: 1 },
    { name: "b", rank: 2 },
  ]),
  names([{ name: "t", tag: "x" }]),
);
