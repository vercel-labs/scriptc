// Recursive and forwarding helpers with several callbacks: recursion that
// forwards its callback, recursion that switches callbacks, helper chains,
// and callbacks captured by inner closures and array methods.
function quickSort(
  values: number[],
  lo: number,
  hi: number,
  cmp: (a: number, b: number) => number,
): void {
  if (lo >= hi) return;
  const pivot = values[(lo + hi) >> 1]!;
  let i = lo;
  let j = hi;
  while (i <= j) {
    while (cmp(values[i]!, pivot) < 0) i++;
    while (cmp(values[j]!, pivot) > 0) j--;
    if (i <= j) {
      const t = values[i]!;
      values[i] = values[j]!;
      values[j] = t;
      i++;
      j--;
    }
  }
  quickSort(values, lo, j, cmp);
  quickSort(values, i, hi, cmp);
}

interface Tree {
  value: number;
  children: Tree[];
}

// Mutual recursion forwarding one visitor.
function visitTree(tree: Tree, visit: (value: number, depth: number) => void, depth: number): void {
  visit(tree.value, depth);
  visitChildren(tree.children, visit, depth + 1);
}
function visitChildren(
  children: Tree[],
  visit: (value: number, depth: number) => void,
  depth: number,
): void {
  for (const child of children) visitTree(child, visit, depth);
}

// Recursion that passes a different callback below the first level.
function render(tree: Tree, format: (value: number) => string, out: string[]): void {
  out.push(format(tree.value));
  for (const child of tree.children) render(child, (v) => "<" + format(v) + ">", out);
}

// A chain of helpers forwarding the callback.
function total<T>(items: T[], key: (item: T) => number): number {
  return sum(items.map(key));
}
function sum(values: number[]): number {
  let s = 0;
  for (const v of values) s += v;
  return s;
}
function weighted<T>(items: T[], key: (item: T) => number, weight: number): number {
  return total(items, key) * weight;
}

// The callback captured by closures the helper creates.
function sumBy<T>(items: T[], key: (item: T) => number): number {
  return items.reduce((acc, item) => acc + key(item), 0);
}
function anyBy<T>(items: T[], test: (item: T) => boolean): boolean {
  let found = false;
  items.forEach((item) => {
    if (test(item)) found = true;
  });
  return found;
}
function compose(f: (x: number) => number, g: (x: number) => number): (x: number) => number {
  return (x) => g(f(x));
}
function applyTwice(values: number[], f: (x: number) => number): number[] {
  const twice = (x: number): number => f(f(x));
  return values.map(twice);
}

function fib(n: number, memo: (k: number) => number): number {
  return n < 2 ? n : memo(n - 1) + memo(n - 2);
}

function main(): void {
  const data = [5, 3, 9, 1, 7, 2, 8, 6, 4, 0];
  const asc = data.slice();
  quickSort(asc, 0, asc.length - 1, (a, b) => a - b);
  const desc = data.slice();
  quickSort(desc, 0, desc.length - 1, (a, b) => b - a);
  const parity = data.slice();
  quickSort(parity, 0, parity.length - 1, (a, b) => (a & 1) - (b & 1) || a - b);
  console.log(asc.join(","), desc.join(","), parity.join(","));

  const tree: Tree = {
    value: 1,
    children: [
      { value: 2, children: [{ value: 4, children: [] }] },
      { value: 3, children: [] },
    ],
  };
  const lines: string[] = [];
  visitTree(tree, (value, depth) => lines.push(" ".repeat(depth) + value), 0);
  let deepest = 0;
  visitTree(
    tree,
    (_value, depth) => {
      if (depth > deepest) deepest = depth;
    },
    0,
  );
  console.log(lines.join("|"), deepest);

  const out: string[] = [];
  render(tree, (v) => String(v * 10), out);
  render(tree, (v) => "#" + v, out);
  console.log(out.join(" "));

  const words = ["alpha", "be", "gamma"];
  console.log(total(words, (w) => w.length), total(data, (n) => n * 2));
  console.log(weighted(words, (w) => w.charCodeAt(0), 2), weighted(data, (n) => n, 3));

  console.log(sumBy(words, (w) => w.length), sumBy(data, (n) => n * n));
  console.log(anyBy(data, (n) => n > 8), anyBy(words, (w) => w === "delta"));
  const inc = compose(
    (x) => x + 1,
    (x) => x * 2,
  );
  const dec = compose(
    (x) => x - 1,
    (x) => x / 2,
  );
  console.log(inc(3), dec(3));
  console.log(applyTwice([1, 2], (x) => x + 10).join(","), applyTwice([1, 2], (x) => x * x).join(","));

  const cache = new Map<number, number>();
  const memo = (k: number): number => {
    const hit = cache.get(k);
    if (hit !== undefined) return hit;
    const v = fib(k, memo);
    cache.set(k, v);
    return v;
  };
  console.log(fib(30, memo), fib(10, (k) => (k < 2 ? k : fib(k - 1, () => 1))));
}

main();
