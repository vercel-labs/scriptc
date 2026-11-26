// Host-call microbenchmark: `run` makes `n` synchronous channel calls whose
// argument is the loop counter. The bound is ToInt32'd first, so the counter
// is a proven whole number below 2^31: every call also exercises the u32
// argument conversion (the range-proved path). The probe times this export
// against a plain C function called in the same loop with the same argument.
declare function tick(seq: number): void;

export function run(n: number): number {
  const count = n | 0;
  let acc = 0;
  for (let i = 0; i < count; i++) {
    tick(i);
    acc += i;
  }
  return acc;
}
