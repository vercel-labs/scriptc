// Untyped values read once (a configuration at startup, a loop's
// initializer, a for...of iterable): dynamic, but not hot, so the build
// names nothing. The loops repeat only typed work.
const config: any = JSON.parse('{"scale": 3, "label": "sum"}');
const scale: number = config.scale;
const label: string = config.label;

function sum(values: number[]): number {
  let total = 0;
  for (const v of values) total += v * scale;
  return total;
}

// Untyped values read once, in a loop's initializer and in a for...of
// iterable: the loops repeat only typed work.
function offsets(raw: any): number {
  let total = 0;
  for (let i: number = raw.start; i < 3; i++) total += i;
  for (const n of raw.extra as number[]) total += n;
  return total;
}

console.log(label, sum([1, 2, 3]), offsets({ start: 1, extra: [4, 5] }));
