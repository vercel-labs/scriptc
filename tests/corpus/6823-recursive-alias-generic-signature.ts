// Generic functions whose parameters use a recursive type alias: the alias
// reaches itself through its own type arguments (`Tree[]` inside `Tree`).
type Tree = string | number | Tree[];
type Json = null | boolean | number | string | Json[];

function flatten<T>(label: T, ...trees: Tree[]): (T | string | number)[] {
  const out: (T | string | number)[] = [label];
  const visit = (tree: Tree): void => {
    if (Array.isArray(tree)) tree.forEach(visit);
    else out.push(tree);
  };
  trees.forEach(visit);
  return out;
}

function tagged<K extends string>(key: K, value: Json): { key: K; text: string } {
  return { key, text: JSON.stringify(value) };
}

function depth<T>(value: T, tree: Tree): [T, number] {
  const measure = (node: Tree): number =>
    Array.isArray(node) ? 1 + Math.max(0, ...node.map(measure)) : 0;
  return [value, measure(tree)];
}

console.log(flatten("root", "a", [1, ["b", [2]]], []).join(","));
console.log(flatten(7, [[["deep"]]]).join(","));
console.log(tagged("config", [1, "two", null, [true, [false]]]));
console.log(depth("x", [[1], [[2, [3]]]]), depth(0, "leaf"));
