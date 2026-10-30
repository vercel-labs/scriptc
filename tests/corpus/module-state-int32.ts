// Module-level number state written from several functions: a generator
// state reduced by a remainder, a counter that goes negative, a value that
// becomes a fraction, writes from a closure and an async function, and a
// read before the declaration runs.

function early(): number {
  return marker + 1;
}
try {
  console.log("early", early());
} catch (error) {
  console.log("early", (error as Error).name);
}

let marker = 5;
let seed = 42;
let balance = 10;
let ratio = 3;
let ticks = 0;

function next(): number {
  seed = (seed * 3877 + 29573) % 139968;
  return seed;
}

function fill(buffer: Float64Array): void {
  let l = seed;
  for (let k = 0; k < buffer.length; k++) {
    l = (l * 3877 + 29573) % 139968;
    buffer[k] = l / 139968;
  }
  seed = l;
}

function spend(amount: number): number {
  balance = (balance & 1023) - amount;
  return balance;
}

function halve(): number {
  ratio = ratio / 2;
  return ratio;
}

const tick = (): number => {
  ticks = (ticks + 7) % 10;
  return ticks;
};

async function later(): Promise<number> {
  await Promise.resolve();
  ticks = 9;
  return ticks;
}

const buffer = new Float64Array(5);
console.log("next", next(), next(), next());
fill(buffer);
let shown = "";
for (const v of buffer) shown += ` ${v.toFixed(6)}`;
console.log("fill", shown, seed);
seed = 2147483647;
console.log("large", next(), next());
seed = 0;
console.log("zero", next());
console.log("spend", spend(4), spend(30), spend(-2000), spend(5));
console.log("halve", halve(), halve(), ratio * 4);
console.log("tick", tick(), tick(), tick(), ticks);
console.log("later", await later(), ticks, tick());
marker = marker * 3;
console.log("marker", early(), marker);
