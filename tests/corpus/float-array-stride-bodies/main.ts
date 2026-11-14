// A loop over bodies in a flat Float64Array, bounded by a quotient of the
// array's length. The index goes through a constant body temp (`at`), so the
// loop keeps its counter in integers and its accesses share one bounds check
// rather than taking one per access.
const STRIDE = 7;

function advance(data: Float64Array): number {
  const bodies = data.length / STRIDE;
  for (let b = 0; b < bodies; b++) {
    const at = b * STRIDE;
    const x = data[at]! + data[at + 3]! * 0.5;
    const y = data[at + 1]! + data[at + 4]! * 0.5;
    const z = data[at + 2]! + data[at + 5]! * 0.5;
    data[at] = x;
    data[at + 1] = y;
    data[at + 2] = z;
    data[at + 6] = x + y + z;
  }
  return bodies;
}

function main(): void {
  const data = new Float64Array(10 * STRIDE);
  for (let i = 0; i < data.length; i++) data[i] = (i % 13) - 6;
  const bodies = advance(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i]!;
  console.log("bodies: " + bodies);
  console.log("sum: " + sum.toFixed(6));
  console.log("head: " + data[0]!.toFixed(3) + "," + data[6]!.toFixed(3));

  // A fractional bound is not an integer: the loop rounds up to whole
  // iterations, as `b < bodies` does for the double quotient.
  const odd = new Float64Array(3 * 2 + 1);
  for (let i = 0; i < odd.length; i++) odd[i] = i;
  let seen = 0;
  for (let b = 0; b < odd.length / 2; b++) seen += 1;
  console.log("fractional bound passes: " + seen);
}

main();
