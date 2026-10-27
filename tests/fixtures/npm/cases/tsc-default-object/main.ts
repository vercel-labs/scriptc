// tsc's CommonJS output for a module with named re-exports AND a default
// export object (`exports.default = { registry: registry_api_1.registry }`,
// the @opentelemetry/api index shape): the named exports still link, read
// through their defineProperty getters.
import { registry, VERSION } from "tscdefault";

console.log(VERSION, registry.count("a", 2), registry.count("a", 3), registry.count("b", 1));
