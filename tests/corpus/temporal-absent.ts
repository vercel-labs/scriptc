// Node 24 defines no Temporal global. Programs that name it type-check
// against TS 7's Temporal declarations and see Node's answers: typeof is
// "undefined", the global object has no such property, and any use throws
// the catchable ReferenceError at the root read, before arguments run.
console.log(typeof Temporal, typeof globalThis.Temporal);
const hasTemporal = typeof Temporal !== "undefined";
console.log("hasTemporal", hasTemporal);

function parseDate(text: string): string {
  if (hasTemporal) return Temporal.PlainDate.from(text).toString();
  return new Date(text).toISOString().slice(0, 10);
}
console.log(parseDate("2024-02-29"));

let evaluated = false;
const argument = (): string => {
  evaluated = true;
  return "2024-01-01";
};
try {
  Temporal.PlainDate.from(argument());
} catch (e) {
  const err = e as Error;
  console.log(err.name, err.message, err instanceof ReferenceError, "argument evaluated:", evaluated);
}
try {
  console.log(Temporal.Now.instant().epochMilliseconds);
} catch (e) {
  console.log((e as Error).message);
}
try {
  new Temporal.Duration(1);
} catch (e) {
  console.log((e as Error).message);
}
