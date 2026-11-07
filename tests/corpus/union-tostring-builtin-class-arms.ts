// `.toString()` on a union with a URL, Date or RegExp arm beside primitive
// ones: each arm answers what its own toString answers, the conversion
// `String(value)` and a template span already perform. The receiver is
// evaluated once.
function target(url: string | URL): string {
  return url.toString().replace(/^wss:/, "https:").replace(/^ws:/, "http:");
}
console.log(target("wss://example.test/a"), target(new URL("ws://example.test/b?q=1#frag")));

const epoch = new Date(Date.UTC(2020, 0, 2, 3, 4, 5));
function stamp(value: Date | number | string): string {
  return value.toString();
}
console.log(stamp(epoch) === epoch.toString(), stamp(42), stamp(0.1 + 0.2), stamp("text"));

function pattern(value: RegExp | string | boolean): string {
  return value.toString();
}
console.log(pattern(/a+b/gi), pattern("plain"), pattern(true));

function mixed(value: URL | RegExp | Date | bigint): string {
  return value.toString();
}
console.log(
  mixed(new URL("https://example.test/x")),
  mixed(/x/),
  mixed(12345678901234567890n),
  mixed(epoch) === String(epoch),
);

let reads = 0;
function next(): string | URL {
  reads++;
  return reads % 2 === 0 ? "even" : new URL("https://example.test/odd");
}
console.log(next().toString(), next().toString(), reads);

interface Holder {
  value: string | URL;
}
const holders: Holder[] = [
  { value: "https://example.test/s" },
  { value: new URL("https://example.test/u") },
];
console.log(holders.map((holder) => `${holder.value.toString()}!`).join(" "));
console.log(holders.map((holder) => holder.value.toString() === String(holder.value)).join(","));
