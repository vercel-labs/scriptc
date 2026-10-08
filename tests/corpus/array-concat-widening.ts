class Entry {
  value = 1;
}
class Detailed extends Entry {
  extra = 9;
}
function combine(first: Entry[], rest: Detailed[]): Entry[] {
  return first.concat(rest, new Detailed(), [new Detailed()]);
}
const detail = new Detailed();
const combined = combine([new Entry()], [detail]);
combined[1].value = 4;
console.log(combined.length, detail.value, combined[1] === detail);
const values: (number | string)[] = ["start"];
const numbers = [1, , 3] as number[];
const absent: number[] = [];
numbers.length = 5;
numbers[3] = absent[0];
const result = values.concat(numbers, "end", [6]);
console.log(result.length, result.join("|"));
for (let i = 0; i < result.length; i++) console.log(i, i in result, result[i] === undefined);
console.log(numbers.length, 1 in numbers, 3 in numbers, 4 in numbers);
const later: number[] = [2];
const log: string[] = [];
function first(): (number | string)[] {
  log.push("receiver");
  return values;
}
function mutate(): string {
  log.push("argument");
  later.push(3);
  values.push("changed");
  return "last";
}
console.log(first().concat(later, mutate()).join("|"), log.join("|"));
const narrow: (number | boolean)[] = [false, 4];
const wide: (number | boolean | string)[] = ["wide"];
console.log(wide.concat(narrow).join("|"));
const nested: Entry[][] = [[new Entry()]];
const inner: Entry[] = [detail];
const tail: Entry[][] = [inner];
console.log(nested.concat(tail).length, nested.concat(tail)[1] === inner);
