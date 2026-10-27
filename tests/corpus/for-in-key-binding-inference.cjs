// A binding declared without a value and written only by for-in heads holds
// strings; comparisons on it do not count as writes.
function keysExcept(object, skip) {
  let name;
  const kept = [];
  for (name in object) {
    if (name !== skip && name !== "other") kept.push(name.toUpperCase());
  }
  for (name in { extra: 1 }) kept.push(name);
  return kept.join(",");
}
console.log(keysExcept({ a: 1, b: 2, c: 3 }, "b"));
function lastAssigned(values) {
  let current;
  current = "start";
  for (const v of values) if (current !== v) current = v;
  return current;
}
console.log(lastAssigned(["x", "y"]));
