// Untyped JavaScript that receives the class instance: it builds its own
// table and reads a key out of it. Neither value it creates is Immutable,
// so neither read may count as one.
export function setText(el, key) {
  const table = { a: "hello" };
  el.text = table[key];
}
