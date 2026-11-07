// A member of a function+namespace merge is a property of the function
// object; writing it by its bare name inside the block has no storage to
// name, so the diagnostic points at the qualified form.
function fmt(n: number): number {
  return n;
}
namespace fmt {
  export let prefix = "#";
  prefix = "$";
  console.log(prefix);
}
console.log(fmt(1));
