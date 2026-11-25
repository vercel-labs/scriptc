// A function whose second parameter is not the index, handed to an array
// method where the checker cannot object (the value comes from an array
// element and the mismatch is acknowledged): JavaScript would pass the index
// as `opts`. The refusal names the parameter and the rewrite.
function show(x: string, opts?: { upper: boolean }): string {
  return opts === undefined ? x : x + "!";
}
const shows: ((x: string, opts?: { upper: boolean }) => string)[] = [show];
// @ts-expect-error the index is not an options record
console.log(["a"].map(shows[0]!));
