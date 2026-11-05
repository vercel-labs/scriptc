// Destructuring a property only an ASSERTED intersection declares keeps its
// refusal where the binding cannot hold what Node binds: a REQUIRED asserted
// field (Node binds undefined into a slot that has no undefined arm) and a
// name on Object.prototype (Node reads the inherited value, not an own
// property).
interface Base {
  _meta?: unknown;
  name: string;
}

function required<T extends Base>(item: T): string {
  const { icons } = item as T & { icons: string[] };
  return String(icons.length);
}

function inherited<T extends Base>(item: T): string {
  const { toString } = item as T & { toString?: unknown };
  return typeof toString;
}

const item = JSON.parse('{"name":"n","icons":["a"]}') as Base;
console.log(required(item));
console.log(inherited(item));
