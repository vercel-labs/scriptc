// ToString of a Symbol throws Node's TypeError from the operators that
// perform it: `'' + sym`, `sym + ''`, `+=` onto a string, and a template
// literal. String(sym) never coerces to a string, so it keeps answering
// "Symbol(desc)", and so does sym.description.
let s = Symbol('desc');
console.log(String(s), typeof s, s.description);

function attempt(label, fn) {
  try {
    console.log(label, fn());
  } catch (e) {
    console.log(label, e.name + ': ' + e.message);
  }
}

attempt('empty-left', () => '' + s);
attempt('left', () => 'a' + s);
attempt('right', () => s + 'b');
attempt('template', () => `${s}`);
attempt('template-around', () => `x${s}y`);
attempt('compound', () => {
  let t = 'start';
  t += s;
  return t;
});
attempt('unary', () => +s);
attempt('well-known', () => 'tag: ' + Symbol.iterator);
attempt('after', () => String(s) + ' and ' + String(s));
