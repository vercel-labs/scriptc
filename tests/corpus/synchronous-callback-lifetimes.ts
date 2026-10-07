function invoke(fn: (value: number) => number, value: number): number {
  return fn(value);
}
function relay(fn: (value: number) => number, value: number): number {
  return invoke(fn, value);
}
function fail(): number {
  throw new Error("argument");
}
function run(seed: number): void {
  let total = seed;
  for (let i = 0; i < 4; i++) {
    console.log(relay((value) => { total += value + i; return total; }, 2));
  }
  try {
    relay((value) => { total += value; return total; }, fail());
  } catch (error) {
    console.log((error as Error).message, total);
  }
  try {
    relay((value) => { total += value; throw new Error("callback"); }, 3);
  } catch (error) {
    console.log((error as Error).message, total);
  }
  console.log(relay((value) => relay((inner) => inner + total, value + 1), 4));
  const values = [1, 2, 3];
  console.log(values.every((value, index, array) => {
    total += value;
    if (index === 0) { array.length = 1; array.length = 3; array[2] = 8; }
    return value < 8;
  }), total);
}
run(5);

function replaceDuringArgument(): number {
  let fn = (value: number): number => value + 1;
  return fn((fn = (value: number): number => value + 10, 2)) + fn(2);
}
console.log(replaceDuringArgument());

class Cell {
  label: string;
  next: Cell | null = null;
  constructor(label: string) { this.label = label; }
}
function referenceCapture(): void {
  let current = new Cell("left");
  current.next = current;
  const length = relay((value) => {
    const previous = current;
    current = new Cell("right");
    return previous.label.length + value;
  }, 2);
  console.log(length, current.label);
}
referenceCapture();

function keep(fn: () => number): () => number { return fn; }
function escaped(value: number): () => number { return keep(() => value); }
const saved = escaped(19);
console.log(saved(), saved === saved);

function invokeSelf(fn: () => number): number { return fn(); }
let published: () => number = () => 0;
console.log(invokeSelf(function named(): number { published = named; return 23; }));
console.log(published());

async function invokeLater(fn: () => Promise<number>): Promise<number> { return await fn(); }
async function later(): Promise<void> {
  let value = 29;
  console.log(await invokeLater(async () => { await Promise.resolve(); return value; }));
  value++;
  console.log(value);
}
later();

function makeNested(fn: () => (() => string)): () => string { return fn(); }
function nestedEscape(): () => string {
  let value = "nested";
  const result = makeNested(() => () => value);
  value += "-kept";
  return result;
}
console.log(nestedEscape()());

function scopedCaptures(): void {
  for (let i = 0; i < 4; i++) {
    try {
      let item = new Cell(String(i));
      item.next = item;
      console.log(relay((value) => {
        const old = item;
        item = new Cell("changed");
        if (value === 1) throw new Error(old.label);
        return old.label.length + item.label.length;
      }, i));
      if (i === 2) continue;
    } catch (error) {
      console.log("caught", (error as Error).message);
    } finally {
      const message = "finally-" + String(i);
      console.log(relay((value) => value + message.length, 0));
    }
  }
}
scopedCaptures();

function capturedProjectionOrder(): void {
  let current = new Cell("old");
  console.log(relay(() => {
    const prefix = current.label.startsWith((current = new Cell("new"), "o"));
    return prefix ? current.label.length : -1;
  }, 0));
}
capturedProjectionOrder();
