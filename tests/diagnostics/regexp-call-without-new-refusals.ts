// `RegExp(pattern)` without `new` returns a RegExp pattern itself (when its
// constructor is RegExp) rather than a copy, so a RegExp or untyped pattern
// refuses; string and undefined patterns are the lowered form.
const source = /ab+c/i;
const same = RegExp(source);

const parsed: any = JSON.parse('"x+"');
const fromAny = RegExp(parsed, "g");

console.log(same.source, fromAny.source);
