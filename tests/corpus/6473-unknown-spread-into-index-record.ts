// Spreading an unknown value into an index-signature record copies its own
// keys in order and spreads nothing for null and undefined.
function build(extra: unknown, attempt: number): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(extra as Record<string, string>),
    "x-attempt": String(attempt),
  };
}
function headersOf<T>(params: { headers?: T }, attempt: number): Record<string, string> {
  return {
    ...params.headers,
    "x-attempt": String(attempt),
  };
}
const parsed: unknown = JSON.parse('{"authorization":"t","content-type":"text/plain"}');
console.log(build(parsed, 1));
console.log(headersOf({ headers: parsed }, 3), headersOf({}, 4));
const nothing: unknown = JSON.parse("null");
const five: unknown = JSON.parse("5");
console.log(headersOf({ headers: nothing }, 5), headersOf({ headers: five }, 6));
