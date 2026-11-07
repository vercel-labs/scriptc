// A write to a built-in member that the build cannot see (the object and the
// key arrive as values) is never ignored: under Node the replacement runs,
// and in a compiled executable the write throws. Each line prints true
// either way.
function replace(object, key, value) {
  object[key] = value;
}
function remove(object, key) {
  delete object[key];
}
function define(object, key, value) {
  Object.defineProperty(object, key, { value, writable: true, configurable: true });
}

function observed(label, object, key, write, use) {
  const original = object[key];
  let calls = 0;
  let outcome;
  try {
    write(object, key, function () {
      calls++;
      return "replaced";
    });
    use();
    outcome = calls > 0 ? "replacement ran" : "ignored";
  } catch (error) {
    outcome = error instanceof Error && calls === 0 ? "write threw" : "use threw";
  }
  // Put the built-in back where the replacement took (Node).
  try {
    write(object, key, original);
  } catch (error) {}
  console.log(label, outcome === "replacement ran" || outcome === "write threw");
}

observed("Array.prototype.push", Array.prototype, "push", replace, () => [].push(1));
observed("Array.prototype.join, defined", Array.prototype, "join", define, () => [1, 2].join("-"));
observed("Map.prototype.get", Map.prototype, "get", replace, () => new Map([[1, 2]]).get(1));
observed("Set.prototype.has", Set.prototype, "has", replace, () => new Set([1]).has(1));
observed("Date.prototype.getTime", Date.prototype, "getTime", replace, () => new Date(5).getTime());
observed("Math.abs", Math, "abs", replace, () => Math.abs(-1));

// Deleting one is refused the same way; under Node the member is gone.
const pop = Array.prototype.pop;
let deleted;
try {
  remove(Array.prototype, "pop");
  deleted = typeof [].pop === "undefined";
} catch (error) {
  deleted = error instanceof Error;
}
try {
  define(Array.prototype, "pop", pop);
} catch (error) {}
console.log("delete Array.prototype.pop", deleted);

// A member the object does not have is still the program's to add.
replace(Array.prototype, "lastItem", function () {
  return this[this.length - 1];
});
console.log(typeof Array.prototype.lastItem, Object.hasOwn(Array.prototype, "lastItem"));
