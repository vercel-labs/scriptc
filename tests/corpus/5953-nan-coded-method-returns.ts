// A method that returns a typed-array element or a numeric record entry
// answers undefined for a missing one when its caller can observe it, and
// a plain number when every caller only uses it numerically.
export {};

class Samples {
  values = new Float64Array([1.5, 2.5]);
  at(index: number): number {
    return this.values[index];
  }
  sum(count: number): number {
    let total = 0;
    for (let i = 0; i < count; i++) total += this.at(i);
    return total;
  }
}
const samples = new Samples();
console.log(samples.at(0), samples.at(9));
const missing = samples.at(9);
console.log(missing === undefined, typeof missing);
console.log(samples.sum(2), samples.sum(3));

class Scores {
  table: Record<string, number> = { ada: 3 };
  score(name: string): number {
    return this.table[name];
  }
  doubled(name: string): number {
    return this.score(name) * 2;
  }
}
const scores = new Scores();
console.log(scores.score("ada"), scores.score("bob"));
console.log(scores.doubled("ada"), scores.doubled("bob"));

class Readings {
  data = new Float64Array(1);
  read(index: number) {
    return this.data[index];
  }
}
const readings = new Readings();
const late = readings.read(5);
console.log(late, readings.read(0));
