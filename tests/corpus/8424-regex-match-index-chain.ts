// A match row read through an optional chain: `re.exec(s)?.index` and the
// `?.input` beside it take the same member reads as the guarded form.
const re = /b(c)/g;
const text = "abcz";
const m = re.exec(text);
console.log(m !== null ? m.index : -1);
console.log(re.exec(text)?.index);
console.log(re.exec(text)?.input);
console.log(/(z)/.exec(text)?.index);
console.log(/q/.exec(text)?.index);
const groups = /(?<lead>b)/.exec(text)?.groups;
console.log(groups?.lead);
