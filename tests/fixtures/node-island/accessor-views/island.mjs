import { Sink } from "./shapes.mjs";

// Reads the compiled getter `n` times from island code and drops every
// chunk it returns.
export function drain(sink, n) {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += sink.chunk.length;
  return sum;
}

export function make() {
  return new Sink();
}

// The process's peak resident set, in KiB, for the test that compares runs.
export function peakRss() {
  return process.resourceUsage().maxRSS;
}
