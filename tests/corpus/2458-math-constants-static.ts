// Math.PI and Math.E are the fixed IEEE constants, so they compile to
// plain static number literals — no island, no --dynamic, exactly Node's
// doubles. Composed through arithmetic and printing like any number.
console.log(Math.PI, Math.E);
// Round-trip through static expressions: these bytes must equal Node's.
console.log(2 * Math.PI, Math.PI / 2, Math.PI + Math.E, Math.E * Math.E);
// Literal doubles flow into number methods and conditions like any f64.
console.log(Math.PI.toFixed(9), Math.E.toFixed(9), Math.PI > Math.E);
// A bare read is discarded with zero observable effect (Node evaluates,
// throws the value away), as with any stdlib member read.
Math.PI;
{
  const tau = Math.PI * 2;
  console.log(tau > 6.28, tau < 6.285);
}
// Exact IEEE identity: the static literal IS the ES-spec double, so it
// equals the value written as a decimal literal.
console.log((Math.PI - 3.141592653589793) === 0, (Math.E - 2.718281828459045) === 0);
