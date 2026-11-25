// Runs in Node: `new Function` compiles code from a string.
export function compileAdder(amount: number): (value: number) => number {
  return new Function("value", `return value + ${amount};`) as (value: number) => number;
}

export function describe(label: string): string {
  const where: string = typeof process.versions.v8 === "string" ? "an engine" : "no engine";
  return `${label} module, ${where}`;
}

export function tally(values: number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}
