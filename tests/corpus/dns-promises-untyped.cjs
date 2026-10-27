// The promise forms from CommonJS, with untyped results: lookup's
// { address, family } objects and arrays, the promise form's stricter
// options (family is a number only), a rejected lookup, and
// lookupService's argument checks.
const dnsPromises = require("dns/promises");
const { promises } = require("node:dns");

async function main() {
  console.log(await dnsPromises.lookup("127.0.0.1"));
  console.log(await promises.lookup("::1", { all: true }));
  console.log(await dnsPromises.lookup("localhost", { family: 4 }));
  try {
    dnsPromises.lookup("localhost", { family: "IPv4" });
  } catch (e) {
    console.log(e.code, e.message);
  }
  try {
    dnsPromises.lookup("localhost", "4");
  } catch (e) {
    console.log(e.code, e.message);
  }
  await dnsPromises.lookup("no-such-host.invalid").catch((e) => console.log("rejected", e.code));
  try {
    dnsPromises.lookupService("not-an-ip", 80);
  } catch (e) {
    console.log(e.code, e.message);
  }
  try {
    dnsPromises.lookupService("127.0.0.1", 70000);
  } catch (e) {
    console.log(e.code, e.message);
  }
}
main();
