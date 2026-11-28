// Extending a defaulted generic class through a bracketed namespace member:
// Node instantiates the defaults, but a static adoption of the family would
// omit its inherited field initialization, so the form is refused.
import * as dep from "./dep.ts";
class Sub extends dep["Box"] {}
console.log("ok", (new Sub() as unknown as { value: string }).value);
