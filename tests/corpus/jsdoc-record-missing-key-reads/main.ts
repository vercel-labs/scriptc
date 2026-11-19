// A JSDoc `Object<string, (A|B)>` field read with a key it does not hold
// answers undefined, as three.js reads `geometry.attributes.tangent`.
import { run } from "./geometry.js";

run();
