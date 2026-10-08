// Captured parameters that are rebound anywhere keep one shared binding:
// the body, nested closures, compound and destructuring assignments, and
// loop headers all update the value every closure observes.
function reassignedAfter(count: number): () => number {
  const read = () => count;
  count = count * 2;
  return read;
}
console.log(reassignedAfter(4)());

function reassignedInside(start: number): [() => number, () => void] {
  return [() => start, () => {
    start += 10;
  }];
}
const [get, bump] = reassignedInside(1);
bump();
bump();
console.log(get());

function deeplyReassigned(name: string): () => string {
  const outer = () => {
    const inner = () => {
      name = name + "!";
    };
    inner();
    return name;
  };
  outer();
  return () => name;
}
console.log(deeplyReassigned("hey")());

function compound(total: number, flag: boolean, text: string): () => string {
  const show = () => `${total}/${flag}/${text}`;
  total++;
  total -= 3;
  flag = !flag;
  text ??= "unused";
  text += "+";
  return show;
}
console.log(compound(10, false, "t")());

function destructured(left: number, right: number): () => string {
  const show = () => `${left},${right}`;
  [left, right] = [right, left];
  ({ value: left } = { value: left * 100 });
  return show;
}
console.log(destructured(1, 2)());

function loopTarget(item: string, list: string[]): () => string {
  const show = () => item;
  for (item of list) {
    if (item === "stop") break;
  }
  return show;
}
console.log(loopTarget("none", ["a", "stop", "b"])());

function conditional(level: number, raise: boolean): (() => number)[] {
  const before = () => level;
  if (raise) level = level + 1;
  const after = () => level * 10;
  return [before, after];
}
console.log(conditional(1, true).map((f) => f()), conditional(1, false).map((f) => f()));

function defaulted(size = 3, unit = "cm"): () => string {
  return () => `${size}${unit}`;
}
console.log(defaulted()(), defaulted(5)(), defaulted(undefined, "mm")());

function earlyAndLate(value: number, early: boolean): () => number {
  if (early) return () => value;
  const read = () => value;
  value = -value;
  return read;
}
console.log(earlyAndLate(3, true)(), earlyAndLate(3, false)());
