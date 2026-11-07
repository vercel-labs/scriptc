// An interface with a call signature and data members, built by a cast.
interface Counter {
  (): number;
  count: number;
  reset(): void;
}
function makeCounter(): Counter {
  const c = (() => ++c.count) as Counter;
  c.count = 0;
  c.reset = () => {
    c.count = 0;
  };
  return c;
}
const c = makeCounter();
c();
c();
console.log(c.count);
c.reset();
console.log(c(), Object.keys(c));
