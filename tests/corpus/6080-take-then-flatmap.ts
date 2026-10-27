// take(n) followed by flatMap counts n source values: the last value
// taken still flattens in full, and nothing is pulled after it.
const log: string[] = [];
function* gen(): Generator<number> { for (let i = 0; i < 4; i++) { log.push("y" + i); yield i; } }
const flush = (): string => log.splice(0).join(" ");
console.log(gen().take(2).flatMap((x) => [x, x + 10]).toArray(), flush());
console.log([0, 1, 2, 3].values().take(2).flatMap((x) => [x, x + 10]).toArray());
console.log(gen().take(3).flatMap((x) => new Set([x, -x])).toArray(), flush());
console.log(gen().take(2).flatMap((x) => [x, x + 10]).take(3).toArray(), flush());
console.log(gen().take(2).flatMap((x) => [x, x + 10]).find((v) => v === 10), flush());
console.log(gen().take(2).flatMap((x) => [x, x + 10]).some((v) => v > 10), flush());
console.log(gen().filter((x) => x > 0).take(2).flatMap((x) => [x, x]).map((v) => v * 2).toArray(), flush());
const out: number[] = [];
for (const v of gen().take(2).flatMap((x) => [x, x + 10])) out.push(v);
console.log(out, flush());
const h = gen().take(1).flatMap((x) => [x, x + 1, x + 2]);
console.log(h.next(), h.next(), h.next(), h.next(), flush());
console.log(gen().take(0).flatMap((x) => [x]).toArray(), flush());
console.log(gen().take(2).flatMap((x) => [x]).flatMap((x) => [x, -x]).toArray(), flush());
