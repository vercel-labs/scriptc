// A function's expando member is an own property of the function object
// (the closure's property table), so a read through an alias of the same
// function answers the value written through the original binding, and a
// later write through either name is seen through the other.
interface Combo {
  (value: number): number;
  tag?: string;
}
const combo: Combo = (value: number) => value * 2;
combo.tag = "t";
const alias = combo;
console.log(alias.tag, alias(2), alias === combo);
combo.tag = "u";
console.log(alias.tag, combo.tag);
