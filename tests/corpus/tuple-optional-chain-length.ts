// A tuple's length read through an optional chain is the tuple's arity, as
// the plain read is; a nullish receiver answers undefined and the receiver
// still evaluates once.
function count(stages: [string] | undefined): number {
  return stages?.length ?? 0;
}

const single: [string] = ["one"];
const missing = undefined as [string] | undefined;
console.log(count(single), count(missing));
console.log(single?.length, missing?.length);

let calls = 0;
function pick(): [string] | undefined {
  calls++;
  return ["x"];
}
console.log(pick()?.length, calls);
