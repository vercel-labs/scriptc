// TypeScript `any` operators compile in the dynamic tier: numbers are jsval
// immediates between operators, and results cross back into typed code and
// dynamic objects exactly as before.
function scale(value: any, factor: any): any {
  return value * factor + 1;
}

function mean(values: any): number {
  let total: any = 0;
  for (let i = 0; i < values.length; i++) total = total + values[i];
  return total / values.length;
}

function describe(input: any): string {
  const doubled = input + input;
  return `${typeof doubled}:${doubled}`;
}

console.log(scale(20, 2), scale("3", "4"), scale(1.5, -0), scale(true, null));
console.log(mean([1, 2, 3, 4]), mean(JSON.parse("[0.5, 0.25, 0.125]")));
console.log(describe(21), describe("ab"), describe(true), describe(null));

const stats: any = { hits: 0, misses: 0, ratio: 0 };
for (let i = 0; i < 1000; i++) {
  if (i % 3 === 0) stats.hits = stats.hits + 1;
  else stats.misses += 1;
}
stats.ratio = stats.hits / (stats.hits + stats.misses);
console.log(JSON.stringify(stats));

let counter: any = JSON.parse("41");
counter++;
const before: number = counter--;
console.log(counter, before, counter < before, counter * 2 >= 82);

const weird: any = { valueOf: () => 7 };
const fromObject: number = weird * 6;
console.log(fromObject, weird + 1, weird > 6);

function guarded(x: any): string {
  try {
    const n: number = x - 1;
    return `ok ${n}`;
  } catch (error) {
    return `threw ${(error as Error).message}`;
  }
}
console.log(guarded(5), guarded("5"), guarded(5n));
