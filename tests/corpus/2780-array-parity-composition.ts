// Cross-feature contract: sparse storage, copying sort, and missing-value
// reads must agree when used together, including through an alias.
const source: (number | undefined)[] = [];
source[4] = 30;
source[1] = undefined;
source[3] = 10;
const alias = source;
function describe(label: string, values: (number | undefined)[]): void {
  const present: string[] = [];
  values.forEach((value, index) => {
    present.push(`${index}:${value}`);
  });
  console.log(label, values.length, present.join(","));
}
describe("source", source);

const ordered = source.toSorted((left, right) => (left ?? 0) - (right ?? 0));
describe("copy", ordered);
console.log("same-alias", alias === source);
describe("alias", alias);

source.sort((left, right) => (left ?? 0) - (right ?? 0));
describe("sorted", alias);

source.length = 1;
source.length = 4;
describe("regrown", source);
const [first, second] = source;
console.log("read", first, second, source[8], source.pop(), source.length);
