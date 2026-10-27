// @disallow-code-generation
// The probe packages ship (zod 4's allowsEval): an aliased Function
// constructor inside try/catch decides between a generated fast path and
// an interpreted fallback. Arguments convert to strings before the
// refusal, calling an object's toString.
const F = Function;
function allowsEval() {
  try {
    new F("");
    return true;
  } catch (e) {
    console.log("probe:", e.constructor === EvalError, e.message);
    return false;
  }
}
const parse = allowsEval()
  ? new F("input", "return input.trim()")
  : (input) => input.trim();
console.log(JSON.stringify(parse("  value  ")));

try {
  new Function({ toString() { console.log("toString called"); return "x"; } }, "return x");
} catch (e) {
  console.log(String(e));
}
try {
  eval({ toString() { console.log("never called"); return "1"; } });
} catch (e) {
  console.log(String(e));
}
const indirect = eval;
try {
  indirect("1");
} catch (e) {
  console.log(e.name);
}
