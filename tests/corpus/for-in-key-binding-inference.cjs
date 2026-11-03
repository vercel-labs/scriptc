// A binding declared without a value and written only by a for-in head
// holds strings.
function keysExcept(object, skip) {
  let name;
  const kept = [];
  for (name in object) if (name !== skip) kept.push(name.toUpperCase());
  return kept.join(",");
}
console.log(keysExcept({ a: 1, b: 2, c: 3 }, "b"));
