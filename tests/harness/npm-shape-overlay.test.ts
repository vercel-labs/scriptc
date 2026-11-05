/* Shape inference's overlay never breaks compilation: every npm case
 * compiles with the overlay on and builds and runs exactly as it does in the
 * default build (npm-suite.ts's KNOWN). An overlay annotation whose lowering
 * is refused is dropped, so its declaration compiles untyped. */
import { defineNpmSuite } from "./npm-suite.js";

defineNpmSuite({ label: "npm native, shape overlay", shapeOverlay: true });
