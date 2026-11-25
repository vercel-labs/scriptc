export const table = { text: String, amount: Number, flag: Boolean };

export function kindOf(fn) {
  if (fn === String) return "String";
  if (fn === Number) return "Number";
  if (fn === Boolean) return "Boolean";
  if (fn === BigInt) return "BigInt";
  return typeof fn;
}

// Calls the function the way an untyped parser does: with no argument, with
// one of each primitive kind, and with surplus arguments.
export function describe(fn) {
  const results = [fn.name, fn.length, typeof fn];
  for (const args of [[], ["7"], [7], [true], ["7", "name", undefined]]) {
    try {
      const value = fn(...args);
      results.push(typeof value + ":" + String(value));
    } catch (err) {
      results.push("throws " + err.name);
    }
  }
  return results.join(" ");
}

export function pickByName(name) {
  return name === "String" ? String : name === "Number" ? Number : name === "Boolean" ? Boolean : BigInt;
}
