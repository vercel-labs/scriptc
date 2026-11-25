// @exit: 1
// `var E` holds undefined until the enum's declaration runs: a function
// called before it cannot enumerate the object. Node throws a TypeError
// here; the compiled program never answers the object early either.
function names(): string[] {
  return Object.keys(Level);
}
console.log("before the declaration");
console.log(names().join(","));
enum Level {
  Low,
  High,
}
console.log("unreachable", names().join(","));
