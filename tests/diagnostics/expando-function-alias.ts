// A function expando member lives in a module global keyed by the DECLARING
// symbol; an alias of the same function is a different symbol, so its read
// cannot route to that slot. The read stays fenced instead of answering
// undefined where Node answers the value.
interface Combo {
  (value: number): number;
  tag?: string;
}
const combo: Combo = (value: number) => value * 2;
combo.tag = "t";
const alias = combo;
console.log(alias.tag);
// End of the function expando alias diagnostic fixture.
