// String match and search in JavaScript with a pattern that may be undefined
// (a Map lookup or an array read): a RegExp matches as usual, and an
// undefined pattern is `new RegExp(undefined)`, the empty pattern.
const text = 'agggtaaa tttaccct agggtaaa';
const patterns = new Map([
  ['forward', /agggtaaa/g],
  ['either', /agggtaaa|tttaccct/gi],
  ['first', /t+a/],
]);
for (const name of ['forward', 'either', 'first', 'missing']) {
  const re = patterns.get(name);
  const m = text.match(re);
  console.log(name, m === null ? null : m.length, m === null ? '' : JSON.stringify([...m]), text.search(re));
}

const list = [/a(g+)/, /x/];
for (let i = 0; i < 3; i++) {
  const m = text.match(list[i]);
  console.log(i, m === null ? 'null' : `${m[0]} at ${m.index} ${m[1] ?? ''}`, text.search(list[i]));
}
