// A function boxed where its name is not known statically (held in a record,
// an array or a map that is converted to unknown) answers the name of the
// function it holds: the box looks the function up among the program's
// named functions. Enough named functions for the lookup to have depth, read
// in an order unrelated to their declaration order, with unnamed functions
// (which have no entry) in between.
function step00(): number {
  return 0;
}
function step01(): number {
  return 1;
}
function step02(): number {
  return 2;
}
function step03(): number {
  return 3;
}
function step04(): number {
  return 4;
}
function step05(): number {
  return 5;
}
function step06(): number {
  return 6;
}
function step07(): number {
  return 7;
}
function step08(): number {
  return 8;
}
function step09(): number {
  return 9;
}
function step10(): number {
  return 10;
}
function step11(): number {
  return 11;
}
function step12(): number {
  return 12;
}
function step13(): number {
  return 13;
}
function step14(): number {
  return 14;
}
function step15(): number {
  return 15;
}
function step16(): number {
  return 16;
}
function step17(): number {
  return 17;
}
function step18(): number {
  return 18;
}
function step19(): number {
  return 19;
}
function step20(): number {
  return 20;
}
function step21(): number {
  return 21;
}
function step22(): number {
  return 22;
}
function step23(): number {
  return 23;
}
function step24(): number {
  return 24;
}
function step25(): number {
  return 25;
}
function step26(): number {
  return 26;
}
function step27(): number {
  return 27;
}
function step28(): number {
  return 28;
}
function step29(): number {
  return 29;
}
function step30(): number {
  return 30;
}
function step31(): number {
  return 31;
}
function step32(): number {
  return 32;
}
function step33(): number {
  return 33;
}
function step34(): number {
  return 34;
}
function step35(): number {
  return 35;
}
function step36(): number {
  return 36;
}
function step37(): number {
  return 37;
}
function step38(): number {
  return 38;
}
function step39(): number {
  return 39;
}
function step40(): number {
  return 40;
}
function step41(): number {
  return 41;
}
function step42(): number {
  return 42;
}
function step43(): number {
  return 43;
}
function step44(): number {
  return 44;
}
function step45(): number {
  return 45;
}
function step46(): number {
  return 46;
}
function step47(): number {
  return 47;
}
const steps: (() => number)[] = [
  step00,
  step01,
  step02,
  step03,
  step04,
  step05,
  step06,
  step07,
  step08,
  step09,
  step10,
  step11,
  step12,
  step13,
  step14,
  step15,
  step16,
  step17,
  step18,
  step19,
  step20,
  step21,
  step22,
  step23,
  step24,
  step25,
  step26,
  step27,
  step28,
  step29,
  step30,
  step31,
  step32,
  step33,
  step34,
  step35,
  step36,
  step37,
  step38,
  step39,
  step40,
  step41,
  step42,
  step43,
  step44,
  step45,
  step46,
  step47,
];

const expression = function inner(): number {
  return 100;
};
const arrow = (): number => 101;
const literal = {
  method(): number {
    return 102;
  },
  "quoted key"(): number {
    return 103;
  },
  7(): number {
    return 104;
  },
};
function makeCounter(start: number): () => number {
  let next = start;
  return function counter(): number {
    return next++;
  };
}
const counter = makeCounter(5);

function nameOf(value: unknown): string {
  return typeof value === "function" ? JSON.stringify(value.name) : "not a function";
}

// Every declared function, through an array: 17 is coprime to the count, so
// the order walks the whole list.
const all: unknown = steps;
if (Array.isArray(all)) {
  const names: string[] = [];
  for (let i = 0; i < all.length; i++) names.push(nameOf(all[(i * 17) % all.length]));
  console.log(names.join(" "));
}

// Named and unnamed functions side by side in a record.
const mixed = {
  first: steps[0]!,
  last: steps[steps.length - 1]!,
  expression,
  arrow,
  method: literal.method,
  quoted: literal["quoted key"],
  numeric: literal[7],
  counter,
  unnamed: [(): number => 105][0]!,
  unnamedCapturing: ((base: number) => (): number => base)(106),
};
const record: unknown = mixed;
console.log(record);
for (const [key, value] of Object.entries(record as Record<string, unknown>))
  console.log(key, nameOf(value));

// A map of functions, and a function behind a wider signature.
const byKey = new Map<string, () => number>([
  ["a", steps[31]!],
  ["b", () => 107],
  ["c", counter],
]);
const map: unknown = byKey;
console.log(map);
const wider: { run: (extra: number) => number } = { run: steps[12]! };
const widened: unknown = wider;
console.log(widened, nameOf((widened as { run: unknown }).run));

// The same function boxed again answers the same name, and calling through
// the box still reaches it.
for (let round = 0; round < 3; round++) {
  const again: unknown = { f: steps[(round * 19 + 3) % steps.length]!, g: () => round };
  const holder = again as { f: unknown; g: unknown };
  console.log(nameOf(holder.f), nameOf(holder.g), (holder.f as () => number)());
}
