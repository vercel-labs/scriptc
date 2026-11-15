// An untyped module that only asks for the binding's type. Its function is
// called after `document` is initialized, so `typeof` answers "object"
// (cycle-typeof-binding covers a `typeof` that runs before).
import { document } from "./dom.ts";

export function label() {
  return `dom: ${typeof document}`;
}
