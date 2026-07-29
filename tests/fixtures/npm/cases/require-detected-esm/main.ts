// @dynamic
// The package's CommonJS entry synchronously requires a typeless .js child
// whose export syntax makes it ESM under Node 24. require(esm) must return
// the cached namespace instead of taking the legacy ERR_REQUIRE_ESM path.
import required from "require-detected-esm";

console.log(`${required.value}:${required.same}`);
