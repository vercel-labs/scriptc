// @requires-libnode
// An npm package that ships no declarations, imported under `// @ts-ignore`:
// tsc types what it returns `any`, the build runs the package in a Node
// island, and the program maps, filters and reduces arrays of pairs made
// from its results (`any[][]`). An array whose elements are themselves
// arrays of untyped values keeps its array methods.
// @ts-ignore
import distance from 'word-distance';

function closest(input: string, list: string[], threshold: number = 0.5) {
  // Under tsc: (any | string)[][] is any[][], and the comparison below type-checks.
  const rated = list.map(item => [distance(input, item), item]);
  const found = rated.filter(item => item[0] > threshold);
  if (found.length) {
    const best = found.reduce((a, c) => (a[0] > c[0] ? a : c));
    return best[1];
  }
}

console.log(closest('deplyo', ['deploy', 'dev', 'domains']));
