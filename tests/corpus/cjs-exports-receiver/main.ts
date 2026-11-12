// Untyped CommonJS packages written as namespaces: an export calls a sibling
// through `exports.name(...)`, and that sibling reaches further exports
// through `this`, which Node binds to the exports object. The compiled call
// passes the exports those functions read as the receiver; the same function
// called detached or through `.call` keeps the receiver it is given.
import plan from "backoff-plan";
import table from "scale-table";
import strict from "strict-plan";

console.log(String(plan.describe({ steps: 3, base: 10 })));
console.log(String(plan.describe({ steps: 4, base: 1, growth: 3 })));
console.log(String(plan.describe([5, 1, 3])));
console.log(String(table.run()));
console.log(String(strict.run()));
