// A member whose name starts with `__` is an ordinary own property of the
// function object, not a protocol slot: the plain expando path stores it,
// compound writes and reads through an alias observe the one table, and
// Object.keys lists it.
function widget(): string {
  return widget.__tag;
}
widget.__tag = "w1";
widget.__count = 1;
widget.__count += 1;
const alias = widget;
alias.__tag = "w2";
console.log(widget(), widget.__count, alias.__tag, Object.keys(widget).join(","), typeof widget);
