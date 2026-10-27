import { publish } from "@scriptc/threads";

// Classes whose own fields hold nothing cycle-capable, in a hierarchy where
// other classes form cycles: their instances are held by dead cycles, by
// live cycles and by plain locals while collections run, and are published
// with the contexts that hold them.

abstract class Mapper {
  abstract map(n: number): number;
}

class Offset extends Mapper {
  by: number;
  constructor(by: number) {
    super();
    this.by = by;
  }
  map(n: number): number {
    return n + this.by;
  }
}

class Scale extends Offset {
  readonly factor: number;
  constructor(by: number, factor: number) {
    super(by);
    this.factor = factor;
  }
  map(n: number): number {
    return super.map(n) * this.factor;
  }
}

class Context {
  readonly steps: Mapper[] = [];
  mapper: Mapper | undefined = undefined;
  total = 0;
}

class ContextMapper extends Mapper {
  readonly context: Context;
  constructor(context: Context) {
    super();
    this.context = context;
  }
  map(n: number): number {
    let value = n;
    for (const step of this.context.steps) value = step.map(value);
    return value;
  }
}

class Chain extends Mapper {
  readonly first: Mapper;
  next: Mapper | undefined = undefined;
  constructor(first: Mapper) {
    super();
    this.first = first;
  }
  map(n: number): number {
    const value = this.first.map(n);
    return this.next === undefined ? value : this.next.map(value);
  }
}

function makeContext(i: number, shared: Mapper): Context {
  const context = new Context();
  context.steps.push(new Offset(i % 7), shared, new Scale(1, 2));
  context.mapper = new ContextMapper(context);
  context.total = context.mapper.map(i);
  return context;
}

const shared = new Scale(3, 1);
const kept: Context[] = [];
let sum = 0;
for (let i = 0; i < 20000; i++) {
  const context = makeContext(i, shared);
  sum += context.total;
  if (i % 1000 === 0) kept.push(context);
}

// A chain that loops back to itself, holding mappers that are also held
// outside it.
const outside: Mapper[] = [];
let loops = 0;
for (let i = 0; i < 5000; i++) {
  const offset = new Offset(i);
  const head = new Chain(offset);
  const tail = new Chain(new Scale(i, 3));
  head.next = tail;
  tail.next = undefined;
  loops += head.map(1);
  tail.next = head;
  if (i % 500 === 0) outside.push(offset);
}

let keptTotal = 0;
for (const context of kept) keptTotal += context.mapper!.map(1);
let outsideTotal = 0;
for (const mapper of outside) outsideTotal += mapper.map(2);

console.log(sum, loops, kept.length, keptTotal, outside.length, outsideTotal, shared.map(4));

publish(kept);
let publishedTotal = 0;
for (const context of kept) publishedTotal += context.mapper!.map(3);
console.log("published", publishedTotal);
try {
  shared.by = 5;
  console.log("write: ok");
} catch (e) {
  console.log(`write: ${(e as Error).name}: ${(e as Error).message}`);
}
const fresh = makeContext(7, new Offset(1));
fresh.steps.push(shared);
console.log("after", fresh.mapper!.map(2), outside[3]!.map(1));
