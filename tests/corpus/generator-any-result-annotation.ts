// A generator whose declared result type the checker spells as `any` — a
// package generic alias such as Effect.fn.Return<A, E> is one — yields and
// returns untyped values: the yield, return and resume channels are
// checked-dynamic, as `any` is in every other value position.

function* counts(limit: number): any {
  for (let i = 0; i < limit; i++) yield i;
  return `done:${limit}`;
}

const c = counts(2);
console.log(JSON.stringify(c.next()), JSON.stringify(c.next()), JSON.stringify(c.next()));
console.log(JSON.stringify(c.next()));
console.log([...counts(3)].join(","));

function* echo(): any {
  const first = yield "first";
  const second = yield first;
  return `${first}/${second}`;
}

const e = echo();
console.log(JSON.stringify(e.next()));
console.log(JSON.stringify(e.next(7)));
console.log(JSON.stringify(e.next("two")));

let total = 0;
for (const value of counts(4)) total += value;
console.log(total);

async function* ticks(limit: number): any {
  for (let i = 0; i < limit; i++) yield i * 10;
}

const collect = async (): Promise<void> => {
  const seen: number[] = [];
  for await (const tick of ticks(3)) seen.push(tick);
  console.log(seen.join("+"));
};
void collect();
