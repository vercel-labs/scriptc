// Optional values carried through locals and function returns still occupy the UNDEFINED state.
const source: number[] = [12];
const missing = source[8];
function maybe(values: number[]): number {
  return values[8];
}
const localLiteral = [missing, source[0]];
const returnedLiteral = [maybe(source), source[0]];
console.log("local", localLiteral.length, localLiteral[0], localLiteral[1]);
console.log("returned", returnedLiteral.length, returnedLiteral[0], returnedLiteral[1]);
