// A heritage expression with an effect is refused: the static base is
// resolved at compile time, so a computed key (`ns[key()]`) would lose the
// key expression's evaluation, which Node runs at the class statement.
const ns: Record<string, new () => object> = { Base: class {} };
let calls = 0;
function key(): string {
  calls++;
  return "Base";
}
class Sub extends ns[key()] {}
console.log("calls", calls, new Sub() instanceof ns.Base);
