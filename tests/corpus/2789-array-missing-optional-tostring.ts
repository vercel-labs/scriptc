// Optional-call and optional-receiver chains keep their undefined tail while
// checker-proven guards expose the present string to later builtin calls.
type Probe = { get?: () => number };
function probe(present: boolean): Probe {
  return present ? { get: () => 42.5 } : {};
}

const hit = probe(true).get?.()?.toString();
const miss = probe(false).get?.()?.toString();
console.log(hit, miss);
console.log(hit !== undefined && /^42/.test(hit));
console.log(miss !== undefined && /^42/.test(miss));

function maybeNumber(present: boolean): number | undefined {
  return present ? 1e21 : undefined;
}
console.log(maybeNumber(true)?.toString(), maybeNumber(false)?.toString());
