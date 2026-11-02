// The typed twin of 8995: a class expression used as a destructuring or
// parameter default takes the binding identifier's name (NamedEvaluation),
// so `const [C = class {}] = []` binds a class whose `.name` is "C" — the
// binding name, never the source property name — while a named class
// expression keeps its own name. Function and arrow values are covered by
// the JavaScript twin, because reading `.name` off a function value is a
// static-tier refusal (SC2020).

const emptyArr: (new () => object)[] = [];
const emptyObj: { D?: new () => object; key?: new () => object } = {};

// Array and object binding.
const [C = class {}] = emptyArr;
const { D = class {} } = emptyObj;
console.log(C.name, D.name);

// A renamed object key names the CLASS after the binding, not the key.
const { key: E = class {} } = emptyObj;
console.log(E.name);

// The default can sit behind a rest element, and a nested pattern inside a
// parameter names each of its own defaults.
const [G = class {}, ...rest] = emptyArr;
console.log(G.name, rest.length);
function pattern([H = class {}, I = class {}] = [] as (new () => object)[]): string {
  return `${H.name}/${I.name}`;
}
console.log(pattern());

// A plain parameter default names the class after the parameter.
function paramDefault(J: new () => object = class {}): string {
  return J.name;
}
console.log(paramDefault());

// A named class expression and a default that is not a definition keep the
// value's own name.
class Named {}
const [K = class Explicit {}] = emptyArr;
const [L = Named] = emptyArr;
console.log(K.name, L.name);
