// Element reads of arrays whose element type admits undefined: a slot that
// holds the absent value is a value of the element type, not a hole, and the
// read answers undefined without a runtime lookup. Class elements keep the
// reference counted read of the arm.

class Node {
  value: number;
  constructor(value: number) {
    this.value = value;
  }
}

function sumOptional(values: (number | undefined)[]): number {
  let total = 0;
  let absent = 0;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value === undefined) absent++;
    else total += value;
  }
  return total * 100 + absent;
}

function labelOf(labels: (string | undefined)[], index: number): string {
  const label = labels[index];
  return label === undefined ? "<absent>" : label + ":" + label.length;
}

const numbers: (number | undefined)[] = [1, undefined, 3, undefined, 5];
const pushed: (number | undefined)[] = [];
for (const value of numbers) pushed.push(value);
pushed.push(undefined);
pushed.push(7);
console.log(sumOptional(numbers), sumOptional(pushed), pushed.length);

const labels: (string | undefined)[] = ["alpha", undefined, "beta"];
labels.push(undefined);
labels.unshift(undefined);
const rendered: string[] = [];
for (let i = 0; i < labels.length; i++) rendered.push(labelOf(labels, i));
console.log(rendered.join("|"), labels.length);

const nodes: (Node | undefined)[] = [new Node(3), undefined, new Node(4)];
let total = 0;
for (let round = 0; round < 3; round++) {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node !== undefined) total += node.value;
    else total--;
  }
  const first = nodes[0];
  if (first !== undefined) first.value += 1;
}
console.log(total, nodes[0]?.value, nodes[1], nodes[2]?.value);

const absentEverywhere: (number | undefined)[] = [undefined, undefined, undefined];
console.log(sumOptional(absentEverywhere));

// Reference elements whose absent value is the null sentinel: the read of the
// absent slot and the retain that follows it both have to accept null.
const rows: (number[] | undefined)[] = [undefined, [1, 2], undefined];
let rowLengths = 0;
for (let i = 0; i < rows.length; i++) {
  const row = rows[i];
  if (row === undefined) rowLengths--;
  else rowLengths += row.length;
}
console.log(rowLengths, rows[0] === undefined, rows[1]?.length);

const chunks: (Uint8Array | undefined)[] = [undefined, new Uint8Array([7, 8, 9])];
let chunkBytes = 0;
for (let i = 0; i < chunks.length; i++) {
  const chunk = chunks[i];
  if (chunk === undefined) chunkBytes--;
  else chunkBytes += chunk.length;
}
console.log(chunkBytes, chunks[0] === undefined, chunks[1]?.length);

const mixed = [undefined, 1, undefined, 2];
console.log(sumOptional(mixed), mixed[0], mixed[1], mixed[3]);
