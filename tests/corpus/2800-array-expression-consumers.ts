let fallbackCalls = 0;
function fallback(): string {
  fallbackCalls++;
  return "fallback";
}
const empty: string | undefined = "";
const missing: string | undefined = undefined;
console.log("nullish", (empty ?? fallback()).length, fallbackCalls);
console.log("nullish", (missing ?? fallback()).length, fallbackCalls);

const numbers: number[] = [3.9];
let unaryCalls = 0;
function optionalNumber(): number {
  unaryCalls++;
  return numbers[1];
}
console.log("unary", -numbers[0], ~optionalNumber(), unaryCalls);

const grid: number[][] = [[]];
grid[0][0] = 7;
console.log("nested", grid[0][0]);
