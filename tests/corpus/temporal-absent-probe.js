// The feature-probe shape packages ship (smol-toml's date handling): a
// JavaScript module checks for Temporal and falls back to Date, reading
// the global object too.
const temporal = typeof Temporal === "object" ? Temporal : null;
console.log(temporal, globalThis.Temporal, "Temporal" in globalThis);

function toDate(value) {
  if (temporal !== null) return temporal.Instant.from(value).toString();
  return new Date(value).toISOString();
}
console.log(toDate("1979-05-27T07:32:00Z"));

try {
  Temporal.Now.plainDateISO();
} catch (e) {
  console.log(e.name + ": " + e.message);
}
