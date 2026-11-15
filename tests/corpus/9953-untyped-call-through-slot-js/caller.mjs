// Untyped callers: they call what they are handed.
export function callBack(show, payload) {
  return show(payload);
}

const kept = [];
export function keep(show) {
  kept.push(show);
  return kept.length - 1;
}
export function callWith(index, payload) {
  const show = kept[index];
  return show.call(undefined, payload);
}
