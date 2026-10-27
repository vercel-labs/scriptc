// A const array spread that runs more than once per evaluation of its
// initializer inserts the same elements each time: in a loop body or in a
// function, `results[1] === results[2]` holds in Node. Converting the
// elements into the destination's layout would copy them on each run, so
// these spreads keep the element-layout refusal.
type Result = { message: string; file: { path: string } | undefined; noisy: boolean };
const results: Result[] = [];
const looped = [{ message: "loop", file: undefined, noisy: false }];
for (let i = 0; i < 2; i++) results.push(...looped);
const called = [{ message: "call", file: undefined, noisy: true }];
function addCalled(): void {
  results.unshift(...called);
}
addCalled();
addCalled();
console.log(results.length, results[0] === results[1]);
