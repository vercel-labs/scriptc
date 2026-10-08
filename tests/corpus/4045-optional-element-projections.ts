// Element reads of class arrays compared, tested, and chained directly.
// Holes, explicit undefined, out-of-range indices, operand order, and
// mutation during later operands keep JavaScript's results.
class Part {
  readonly label: string;
  weight: number;
  constructor(label: string, weight: number) {
    this.label = label;
    this.weight = weight;
  }
  heavier(limit: number): boolean {
    return this.weight > limit;
  }
}

const bolt = new Part("bolt", 2);
const gear = new Part("gear", 7);
const nut = new Part("nut", 1);
const parts: Part[] = [bolt, gear, nut];
const order = [2, 0, 1, 5, -1, 1.5];

function positions(list: Part[], probe: Part): string {
  const found: string[] = [];
  for (let j = 0; j < order.length; j++) {
    if (list[order[j]] === probe) found.push(`same@${j}`);
    if (list[order[j]] !== probe) found.push(`diff@${j}`);
    if (list[order[j]] === undefined) found.push(`missing@${j}`);
  }
  return found.join(" ");
}
console.log(positions(parts, gear));

function weights(list: Part[]): string {
  const out: string[] = [];
  for (let j = 0; j < order.length; j++) {
    out.push(String(list[order[j]]?.weight ?? "none"));
    out.push(list[order[j]]?.label ?? "-");
  }
  return out.join(",");
}
console.log(weights(parts));

function looped(list: Part[], probe: Part): number {
  let hits = 0;
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (item === probe) hits += 10;
    if (item !== undefined && item.heavier(1)) hits++;
    if (!item) hits += 100;
  }
  return hits;
}
console.log(looped(parts, bolt));

// Holes and explicit undefined values stored behind a bare element type.
const sparse: Part[] = [bolt];
sparse[3] = nut;
const unknownSlot: Part[] = [];
sparse[2] = unknownSlot[9];
console.log(sparse.length, looped(sparse, nut), 1 in sparse, 2 in sparse);
console.log(sparse[1] === sparse[2], sparse[1] === undefined, sparse[2] === undefined);
console.log(sparse[1]?.label ?? "hole", sparse[2]?.label ?? "explicit");

// The left operand is read before the right operand mutates the array.
const queue: Part[] = [bolt, gear];
console.log(queue[0] === queue.shift(), queue.length);
console.log(queue[0] === (queue[0] = nut), queue[0].label);
let reads = 0;
function at(list: Part[], index: number): number {
  reads++;
  return index;
}
console.log(parts[at(parts, 1)] === parts[at(parts, 1)], reads);
console.log(parts[at(parts, 9)] === parts[at(parts, 8)], reads);

// Reads inside callbacks and nested functions use the same rules.
const probes = [bolt, nut, new Part("bolt", 2)];
const matches = probes.map((probe) => {
  let count = 0;
  for (let i = 0; i <= parts.length; i++) {
    const item = parts[i];
    if (item === probe) count++;
    count += item?.weight ?? 0;
  }
  return count;
});
console.log(matches.join(" "));

// Failed member reads still throw Node's TypeError.
try {
  const shelf: Part[] = [bolt];
  console.log(shelf[order[3]].heavier(0));
} catch (error) {
  console.log((error as Error).name, (error as Error).message);
}

// Identity survives repeated reads, and a mutated element is observed.
const first = parts[0];
parts[0].weight = 11;
console.log(first === parts[0], first.weight, parts[0] === bolt, parts.indexOf(bolt));
