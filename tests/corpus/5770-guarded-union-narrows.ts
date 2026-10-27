// Union narrowings that TypeScript proves are verified at run time: every
// narrowing below reads its payload through a tag guard. Correct programs
// never trip it, so output matches Node across typeof, nullable, tagged,
// switch, early-return, loop and closure narrowings, including payloads
// borrowed for field reads and owned ones stored into arrays.
type Shape =
  | { kind: "circle"; r: number }
  | { kind: "rect"; w: number; h: number }
  | { kind: "label"; text: string };

class Node2 {
  value: number;
  next: Node2 | null;
  constructor(value: number, next: Node2 | null) {
    this.value = value;
    this.next = next;
  }
}

function describe(v: string | number | boolean): string {
  if (typeof v === "string") return `string:${v.length}:${v.toUpperCase()}`;
  if (typeof v === "number") return `number:${(v * 2).toFixed(1)}`;
  return `boolean:${v ? "yes" : "no"}`;
}

function area(s: Shape): number {
  switch (s.kind) {
    case "circle":
      return Math.round(Math.PI * s.r * s.r);
    case "rect":
      return s.w * s.h;
    case "label":
      return s.text.length;
  }
}

function sumList(head: Node2 | null): number {
  let total = 0;
  let cur = head;
  while (cur !== null) {
    total += cur.value;
    cur = cur.next;
  }
  return total;
}

function firstWord(text: string | undefined): string {
  if (text === undefined) return "<none>";
  const words = text.split(" ");
  return words[0] ?? "";
}

function pickNames(items: (string | number)[]): string[] {
  const names: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") continue;
    names.push(item);
  }
  return names;
}

function makeFormatter(prefix: string | null): (n: number) => string {
  const p = prefix ?? "#";
  return (n) => `${p}${n}`;
}

const values: (string | number | boolean)[] = ["abc", 4.25, true, "", 0, false];
for (const v of values) console.log(describe(v));

const shapes: Shape[] = [
  { kind: "circle", r: 2 },
  { kind: "rect", w: 3, h: 5 },
  { kind: "label", text: "hello" },
];
let totalArea = 0;
for (let round = 0; round < 1000; round++) for (const s of shapes) totalArea += area(s);
console.log("area", totalArea);

let list: Node2 | null = null;
for (let i = 1; i <= 100; i++) list = new Node2(i, list);
console.log("list", sumList(list), sumList(null));

console.log(firstWord("guarded narrows"), firstWord(undefined), firstWord(""));
console.log(pickNames(["a", 1, "b", 2, "c"]).join(","));
const fmt = makeFormatter(null);
const fmt2 = makeFormatter("n=");
console.log(fmt(1), fmt2(2));

