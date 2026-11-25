// Untyped callers: they pass what they like.
export function callWithThree(f) {
  return f(1, 2, 3);
}
export function hold(f) {
  return { f };
}
export function callMember(holder) {
  return holder.f("a", "b", "c", "d");
}
