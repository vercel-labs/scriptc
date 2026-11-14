// A class that extends Array types its instances as arrays, so a plain array
// can arrive where an instance is expected: parsed from JSON into a
// parameter typed as an array of instances, or asserted to be one. Calling a
// member of the class on such an array throws Node's TypeError; instances
// in the same array keep working.
class Tally extends Array<number> {
  bonus = 10;
  total(): number {
    let sum = this.bonus;
    for (const value of this) sum += value;
    return sum;
  }
  add(value: number): this {
    this.push(value);
    return this;
  }
}

function totals(rows: Tally[]): void {
  for (let i = 0; i < rows.length; i++) {
    try {
      console.log(i, rows[i].total());
    } catch (e) {
      console.log(i, String(e));
    }
  }
  for (const row of rows) {
    try {
      console.log(row.add(1).length);
    } catch (e) {
      console.log(String(e));
    }
  }
}

const real = new Tally();
real.push(1, 2);
const parsed: Tally[] = JSON.parse("[[1, 2, 3], [], [4]]");
totals(parsed);
totals([real, ...parsed]);
console.log(parsed.map((row) => row.length).join(","), parsed[0] instanceof Tally);

const asserted = [5, 6] as Tally;
try {
  console.log(asserted.total());
} catch (e) {
  console.log(String(e));
}
const maybe: Tally | undefined = parsed[1];
try {
  console.log(maybe?.total());
} catch (e) {
  console.log(String(e));
}
console.log(real.total(), real.add(3).total());

// The call evaluates its arguments before it finds the method missing, as
// Node does: their side effects happen, and an argument that throws wins.
class Pair extends Array<number> {
  base = 100;
  sum(a: number, b: number): number {
    return this.base + a + b + this.length;
  }
}
const seen: string[] = [];
const note = (label: string, value: number): number => {
  seen.push(label);
  return value;
};
const pairs: Pair[] = JSON.parse("[[1]]");
const realPair = new Pair();
realPair.push(7);
for (const pair of [realPair, ...pairs]) {
  seen.length = 0;
  try {
    console.log(pair.sum(note("a", 1), note("b", 2)), seen.join(","));
  } catch (e) {
    console.log(String(e), seen.join(","));
  }
}
try {
  pairs[0].sum(
    note("c", 1),
    (() => {
      throw new Error("argument threw");
    })(),
  );
} catch (e) {
  console.log(String(e));
}
let shifting = 1;
console.log(realPair.sum(shifting, (shifting = 5)), shifting);
