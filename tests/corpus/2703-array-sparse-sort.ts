type MaybeNumber = number | undefined;

function describe(label: string, values: MaybeNumber[]): void {
  const visits: string[] = [];
  values.forEach((value, index) => {
    visits.push(index + ":" + value);
  });
  console.log(label, values.length, visits.join("|"));
}

const values: MaybeNumber[] = [];
values[4] = 30;
values[1] = undefined;
values[3] = 10;
const alias = values;

describe("before", values);
values.sort((left, right) => (left ?? 0) - (right ?? 0));
describe("sorted", values);
console.log("same", alias === values);
