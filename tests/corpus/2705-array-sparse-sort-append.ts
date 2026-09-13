type MaybeNumber = number | undefined;

function describe(label: string, values: MaybeNumber[]): void {
  const visits: string[] = [];
  values.forEach((value, index) => {
    visits.push(index + ":" + value);
  });
  console.log(label, values.length, visits.join("|"));
}

const values: MaybeNumber[] = [];
values[1] = 3;
values[3] = 1;
let firstComparison = true;

values.sort((left, right) => {
  if (firstComparison) {
    firstComparison = false;
    values.push(99);
    values[6] = 77;
  }
  return (left ?? 0) - (right ?? 0);
});

describe("sorted", values);
console.log("tail", values.length, values[4], values[5], values[6]);
