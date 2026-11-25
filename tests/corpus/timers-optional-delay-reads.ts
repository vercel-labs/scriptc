// @normalize-pid
// A delay typed `number | undefined` read from an array: an element past
// the end is undefined, the default delay, and warns nothing, and an
// element that holds NaN warns once, as Node's Timeout constructor does.
const delays: (number | undefined)[] = [NaN, undefined, 1];
const plain: number[] = [5];
function at(index: number): number | undefined {
  return delays[index];
}
setTimeout(() => console.log("undefined element"), delays[1]);
setTimeout(() => console.log("past the end"), delays[9]);
setTimeout(() => console.log("typed past the end"), plain[3]);
setTimeout(() => console.log("nan element"), delays[0]);
setTimeout(() => console.log("nan through a call"), at(0));
