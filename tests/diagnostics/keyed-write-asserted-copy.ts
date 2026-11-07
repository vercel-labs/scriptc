// A keyed write through a record assertion that changes layout addresses
// the assertion's operand, as the dotted write does
// (tests/corpus/8817-write-erased-wrappers.ts). Where the operand's own
// layout cannot take the write in place, lowering the asserted expression
// would write the assertion's converted copy and drop it without a
// diagnostic, so the write is refused by name.
interface Counts {
  hits: number;
  misses?: number;
}

// An update through a bracket key reads and writes the copy.
function bump(counts: Counts): void {
  (counts as { hits: number })["hits"] += 1;
}

function increment(counts: Counts): void {
  (counts as { hits: number })["hits"]++;
}

function fill(counts: Counts): void {
  (counts as { misses?: number })["misses"] ??= 0;
}

// An index-signature view of another value type converts too.
function widen(table: Record<string, number>, key: string): void {
  (table as Record<string, number | undefined>)["fixed"] = 1;
  (table as Record<string, number | undefined>)[key] = 2;
}

// A member the operand's layout holds at another type.
function retype(counts: Counts): void {
  (counts as { misses?: number | string })["misses"] = "many";
}

// A member only the assertion declares, through the wrappers.
function add(counts: Counts): void {
  (counts as Counts & { extra?: number })!.extra = 1;
}

// In value position.
function value(counts: Counts): number {
  return ((counts as { hits: number })["hits"] = 3);
}

const counts: Counts = { hits: 0 };
bump(counts);
increment(counts);
fill(counts);
widen({ a: 1 }, "b");
retype(counts);
add(counts);
console.log(value(counts));
