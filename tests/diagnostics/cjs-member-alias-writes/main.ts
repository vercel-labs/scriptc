// A member export is read through its binding only when that binding still
// holds the exported value: a member that holds a reassigned binding, or one
// that both a module and its re-exporter write, is refused.
import { counter, version } from "metrics";
console.log(counter);
console.log(version);
