// A function may shadow an inherited Function.prototype member with its own
// data property: `combo.toString = () => "custom"` puts an own enumerable
// property on the function object, and reads and calls address it.
interface Combo {
  (): string;
  toString: () => string;
}

const combo: Combo = (() => "hi") as Combo;
combo.toString = () => "custom";
console.log(combo(), combo.toString(), typeof combo, Object.keys(combo).join(","));

const alias = combo;
alias.toString = () => "again";
console.log(combo.toString(), "toString" in combo, Object.keys(combo).join(","));
