// Spreading a fresh array literal whose elements are typed by their own
// literal (an omitted member reads `undefined`) into an array of the
// declared element type converts the elements; nothing else can reach
// them.
type Result = { message: string; file: { path: string } | undefined; noisy: boolean };
const results: Result[] = [{ message: "first", file: { path: "/a" }, noisy: false }];
const spam = results.length > 0 ? [{ message: "spam", file: undefined, noisy: true }] : [];
const more: Result[] = [{ message: "m", file: undefined, noisy: false }];
results.unshift(...spam, ...more);
const tail = results.length > 5 ? [] : [{ message: "tail", file: undefined, noisy: false }];
results.push(...tail);
console.log(results.map((r) => `${r.message}:${r.file?.path ?? "-"}:${r.noisy}`).join(" "));
console.log(JSON.stringify(results[1]));
// A const declared in the loop body is a new array on every iteration.
for (let i = 0; i < 2; i++) {
  const step = [{ message: `step${i}`, file: undefined, noisy: false }];
  results.push(...step);
}
console.log(results.map((r) => r.message).join(" "), results[results.length - 1] === results[results.length - 2]);
