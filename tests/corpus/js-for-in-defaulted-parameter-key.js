// A for-in head writes a string key into its binding. When the binding is a
// JavaScript parameter, the loop's key replaces whatever the annotation or
// the default named, so the parameter takes checked-dynamic storage and the
// loop stores the key Node stores.

/**
 * @param {number} key
 */
function collect(key = 0) {
  const out = [];
  for (key in { alpha: 1, beta: 2 }) out.push(key);
  return out;
}

console.log("collect", collect().join());
console.log("with argument", collect(7).join());

/**
 * @param {number} index
 */
function walk(index = 0) {
  const keys = [];
  for (index in { one: 1 }) keys.push(typeof index, index);
  return keys.join();
}

console.log("walk", walk(3));
