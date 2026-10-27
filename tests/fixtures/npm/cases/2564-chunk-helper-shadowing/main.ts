// A bundled CommonJS chunk that calls the bundle's top-level `label` while
// a nested function of the chunk declares its own `label`: the chunk
// carries the top-level function along, and each reference keeps its own
// binding.
import { inner, outer } from "gtchunkshadow";

console.log(outer(), inner());
