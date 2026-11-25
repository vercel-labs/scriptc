// A resource timing whose timing info omits the connection and body fields
// answers them as absent (undefined), exactly as Node's optional-chain getters
// read the caller's timing info; the fields the info carries keep their
// values and the transfer-size rule still applies.
import { performance } from "node:perf_hooks";

const entry = performance.markResourceTiming(
  { startTime: 10, endTime: 20 } as any,
  "https://example.test/partial",
  "fetch",
  {} as any,
  "" as any,
  {} as any,
  undefined as any,
);

const fields = [
  "workerStart",
  "redirectStart",
  "redirectEnd",
  "fetchStart",
  "domainLookupStart",
  "domainLookupEnd",
  "connectStart",
  "connectEnd",
  "secureConnectionStart",
  "requestStart",
  "finalResponseHeadersStart",
  "firstInterimResponseStart",
  "responseStart",
  "responseEnd",
  "transferSize",
  "encodedBodySize",
  "decodedBodySize",
];
for (const field of fields) {
  const value = (entry as any)[field];
  console.log(field, typeof value, String(value));
}
console.log("json", JSON.stringify(entry));
