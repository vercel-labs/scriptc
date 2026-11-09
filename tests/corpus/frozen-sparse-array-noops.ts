import { publish } from "@scriptc/threads";

function describe(values: number[]): string {
  let text = values.length + ":";
  for (let i = 0; i < values.length; i++) text += i in values ? values[i] + "," : "_,";
  return text;
}

function exercise(shared: boolean, length: number, mask: number, method: number, to = 0, start = 1, end = 3): void {
  const values: number[] = [];
  values.length = length;
  for (let i = 0; i < length; i++) if (mask & (1 << i)) values[i] = length - i;
  if (shared) publish(values);
  else Object.freeze(values);
  let compared = false;
  let outcome: string;
  try {
    const result = method === 0 ? values.reverse()
      : method === 1 ? values.copyWithin(to, start, end)
      : method === 2 ? values.sort()
      : values.sort((a, b) => { compared = true; return a - b; });
    outcome = "same=" + (result === values);
  } catch (error) {
    outcome = (error as Error).name + ": " + (error as Error).message;
  }
  console.log(shared, length, mask, method, to, start, end, outcome, compared, describe(values));
}

for (const shared of [false, true]) {
  // Every presence pattern distinguishes untouched centers, existing
  // elements, additions into holes, and deletions.
  for (let mask = 0; mask < 8; mask++)
    for (let method = 0; method < 4; method++) exercise(shared, 3, mask, method);
  for (let length = 0; length < 2; length++)
    for (let mask = 0; mask < 2; mask++)
      for (let method = 0; method < 4; method++) exercise(shared, length, mask, method);
  // Overlap reverses traversal. A self-copy still writes present elements.
  for (let mask = 0; mask < 16; mask++) {
    exercise(shared, 4, mask, 1, 1, 0, 3);
    exercise(shared, 4, mask, 1, 0, 1, 4);
    exercise(shared, 4, mask, 1, 0, 0, 4);
  }
  exercise(shared, 3, 0, 1, -2, -3, 99);
  exercise(shared, 3, 4, 1, -2, -3, 99);
  exercise(shared, 3, 7, 1, 99, 0, 3);
  exercise(shared, 3, 7, 1, 0, 2, -3);

  const sparse: number[] = [];
  sparse.length = 1_000_001;
  sparse[500_000] = 7;
  if (shared) publish(sparse);
  else Object.freeze(sparse);
  console.log("sparse center", shared, sparse.reverse() === sparse, sparse.length, sparse[500_000], 0 in sparse, 1_000_000 in sparse);

  const emptyRange = [1];
  if (shared) publish(emptyRange);
  else Object.freeze(emptyRange);
  console.log("empty fill", shared, emptyRange.fill(NaN, 0, 0) === emptyRange, emptyRange[0]);
}

// Undefined is present. Reverse leaves the odd center alone; comparator
// sort must write that element into index zero.
const center: (number | undefined)[] = [];
center.length = 3;
center[1] = undefined;
Object.freeze(center);
console.log("undefined center", center.reverse() === center, 0 in center, 1 in center, 2 in center);
try { center.sort((a, b) => (a ?? 0) - (b ?? 0)); }
catch (error) { console.log("undefined sort", (error as Error).message); }

class Box { value = 7; }
const singleton = publish([new Box()]);
let singletonCalls = 0;
console.log("singleton reference", singleton.sort((a, b) => { singletonCalls++; return a.value - b.value; }) === singleton, singletonCalls, singleton[0]!.value);

const frozen = Object.freeze([3, 2, 1]) as number[];
try { frozen.sort((): number => { throw new Error("comparator stopped"); }); }
catch (error) { console.log("comparator error", (error as Error).message, describe(frozen)); }

const late = [3, 2, 1];
try { late.sort((a, b) => { Object.freeze(late); return a - b; }); }
catch (error) { console.log("frozen during comparison", (error as Error).message, describe(late)); }
