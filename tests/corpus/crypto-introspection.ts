// The crypto statics that report on the process rather than do work:
// getFips, the provider MAC list, the secure-heap record, and setEngine.
import * as crypto from "node:crypto";

function report(label: string, error: Error): void {
  const coded = error as Error & { code?: string; library?: string; reason?: string };
  console.log(
    label,
    "|",
    coded.name,
    "|",
    coded.code,
    "|",
    coded.library,
    "|",
    coded.reason,
    "|",
    coded.message,
  );
}

function attempt(label: string, run: () => unknown): void {
  try {
    const value = run();
    console.log(label, "| ok", value);
  } catch (e) {
    report(label, e as Error);
  }
}

// FIPS mode is off in this build: getFips answers the number 0.
console.log("getFips", crypto.getFips(), typeof crypto.getFips());

// getMacs answers a fresh array of the provider's MAC names, sorted.
const macs = crypto.getMacs();
console.log("macs", macs.join(","));
console.log("macs fresh", macs !== crypto.getMacs(), macs.join(",") === crypto.getMacs().join(","));
macs.push("mutated");
macs[0] = "changed";
console.log("macs unaffected", crypto.getMacs().length, crypto.getMacs()[0]);

// No secure heap is configured, so nothing is used: the totals are 0,
// utilization is 0/0, and the minimum is the default 2.
const usage = crypto.secureHeapUsed();
console.log("secure heap", usage.total, usage.used, usage.utilization, usage.min);
console.log("secure heap keys", Object.keys(usage).join(","));
console.log("secure heap inspect", usage);

// OpenSSL 3 registers only the "dynamic" engine here. The flags value must
// be a number when it is truthy; the search is case-sensitive and stops at
// a NUL in the id.
attempt("setEngine dynamic", () => crypto.setEngine("dynamic"));
attempt("setEngine dynamic flags", () => crypto.setEngine("dynamic", 1));
attempt("setEngine dynamic zero flags", () => crypto.setEngine("dynamic", 0));
attempt("setEngine dynamic null flags", () =>
  crypto.setEngine("dynamic", null as unknown as number),
);
attempt("setEngine dynamic NUL", () => crypto.setEngine("dynamic\u0000x"));
attempt("setEngine unknown", () => crypto.setEngine("nope"));
attempt("setEngine empty", () => crypto.setEngine(""));
attempt("setEngine case", () => crypto.setEngine("Dynamic"));
attempt("setEngine number", () => crypto.setEngine(7 as unknown as string));
attempt("setEngine no args", () => crypto.setEngine(undefined as unknown as string));
attempt("setEngine flags string", () => crypto.setEngine("dynamic", "x" as unknown as number));
attempt("setEngine flags object", () => crypto.setEngine("dynamic", {} as unknown as number));
