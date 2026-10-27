// Function expressions in an untyped JavaScript file: SC6101 names each one
// by its own name, else by the class field, property or variable it is
// assigned to, else as an anonymous function.
class Totals {
  sum = (rows) => {
    let s = 0;
    for (let i = 0; i < rows.length; i++) s += rows[i].n;
    return s;
  };
}

const ops = {
  count: (rows) => {
    let c = 0;
    for (let i = 0; i < rows.length; i++) if (rows[i].n > 1) c++;
    return c;
  },
};

const named = function scale(rows) {
  let s = 0;
  for (let i = 0; i < rows.length; i++) s += rows[i].n * 2;
  return s;
};

const rows = [{ n: 1 }, { n: 2 }];
const results = [rows].map((list) => {
  let s = 0;
  for (let i = 0; i < list.length; i++) s += list[i].n;
  return s;
});
console.log(new Totals().sum(rows), ops.count(rows), named(rows), results[0]);
