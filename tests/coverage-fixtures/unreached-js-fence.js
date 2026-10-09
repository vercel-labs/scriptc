// An exported function nothing on the entry path calls: a statement in it
// that can only fence at runtime still reports its diagnostic, so no
// failed statement goes unexplained.
export function collect(values, flag) {
  var out = { items: [] };
  var x;
  out.items.push((x = +flag, x * 0 === 0) ? x : flag, !!flag);
  return out;
}
console.log("loaded");
