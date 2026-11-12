// An untyped module that only asks for the binding's type. `typeof` never
// reads the storage, so it compiles even though `document` is not
// initialized until the module holding its class finishes.
import { document } from "./dom.ts";

export function label() {
  return `dom: ${typeof document}`;
}
