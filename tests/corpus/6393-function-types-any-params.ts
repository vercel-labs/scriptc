// Function values whose parameters are typed any (optional or not).
function build(limit?: any): string {
  return `limit=${limit ?? "none"}`;
}
const fns: Array<(limit?: any) => string> = [build];
console.log(fns[0]!(), fns[0]!(5));
const take: (v: any) => number = (v) => (typeof v === "number" ? v : -1);
console.log(take(3), take("x"));
