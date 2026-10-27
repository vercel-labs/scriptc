// Strict equality and inequality between a `number | undefined` or
// `boolean | undefined` value and a number or boolean: element reads of
// holes, past the end and of present undefined, NaN, -0 and +0, and
// Object.is, in branches, loops and expressions.

function zeros(a: number[], at: number[]): string {
  const hits: string[] = [];
  for (const i of at) {
    const v = a[i];
    hits.push(`${i}:${v === 0 ? "eq" : "ne"}${v !== 0 ? "!" : ""}${0 === v ? "r" : ""}`);
  }
  return hits.join(" ");
}

const holey: number[] = [0, -0, 1];
holey[5] = 0;
console.log(zeros(holey, [0, 1, 2, 3, 4, 5, 6, -1]));
console.log(zeros([NaN, 0.5, -1, 0], [0, 1, 2, 3]));

function nanAndZeros(a: (number | undefined)[]): string {
  return a
    .map((v) => `${v === -0}${v === 0}${Object.is(v, -0)}${Object.is(v, 0)}${Object.is(v, NaN)}`)
    .join(" ");
}
console.log(nanAndZeros([0, -0, NaN, undefined, 1]));

function flags(a: (boolean | undefined)[]): string {
  let t = 0;
  let f = 0;
  let notTrue = 0;
  for (let i = 0; i < a.length + 2; i++) {
    if (a[i] === true) t++;
    if (a[i] === false) f++;
    if (a[i] !== true) notTrue++;
  }
  return `${t} ${f} ${notTrue}`;
}
const bools: (boolean | undefined)[] = [true, false, undefined, true];
bools[7] = false;
console.log(flags(bools));

// A permutation walk that stops at a zero element, as the flip loops of a
// counting benchmark do.
function walk(p: number[], start: number): number {
  let steps = 0;
  let at = start;
  while (p[at] !== 0 && steps < 20) {
    at = p[at]!;
    steps++;
  }
  return steps;
}
console.log(walk([0, 3, 1, 2], 1), walk([1, 2, 3, 0], 0), walk([2, 2, 2], 0));

class Slot {
  value: number | undefined = undefined;
  on: boolean | undefined = undefined;
}
const slots = [new Slot(), new Slot(), new Slot()];
slots[1]!.value = 0;
slots[1]!.on = true;
slots[2]!.value = -0;
slots[2]!.on = false;
console.log(
  slots
    .map((s) => `${s.value === 0}${s.value !== 0}${s.on === true}${s.on === false}${s.on !== false}`)
    .join(" "),
);
