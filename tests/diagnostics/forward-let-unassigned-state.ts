// A function created above `let x: T;` (no initializer) reads x. Between
// the declaration and the first assignment the read is undefined, so a
// binding whose type cannot hold undefined stays refused. (Types that can
// compile: tests/corpus/forward-captured-uninitialized-let.ts.)
function text(seed: number): string {
  const read = (): string => label + ":" + seed;
  let label: string;
  label = "s";
  return read();
}

function count(seed: number): number {
  const bump = (): void => {
    total += seed;
  };
  let total: number;
  total = 0;
  bump();
  return total;
}

console.log(text(1), count(2));
