// Test-only, for the Node side of tests/harness/tls-spki-blocklist.test.ts:
// Node 24.22.1's own hook for its blocked-SPKI list, fed the same digest the
// native runtime reads from SCRIPTC_TLS_BLOCKED_SPKI. Preloaded with
// --expose-internals; older Node releases do not export the hook, which is
// how the test tells a runnable oracle from a recording.
const { internalBinding } = require("node:internal/test/binding");

const hex = process.env.SCRIPTC_TLS_BLOCKED_SPKI;
if (hex !== undefined && hex !== "") {
  internalBinding("crypto").addBlockedSPKIForTesting(Buffer.from(hex, "hex"));
}
