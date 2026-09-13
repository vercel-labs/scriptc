type MaybeNumber = number | undefined;

function describe(label: string, values: MaybeNumber[]): void {
  const visits: string[] = [];
  values.forEach((value, index) => {
    visits.push(index + ":" + value);
  });
  console.log(label, values.length, visits.join("|"));
}

const source: MaybeNumber[] = [];
source[2] = 20;
source[5] = undefined;

const copy = source.toSorted((left, right) => (left ?? 0) - (right ?? 0));
describe("source", source);
describe("copy", copy);
console.log("same", source === copy);
