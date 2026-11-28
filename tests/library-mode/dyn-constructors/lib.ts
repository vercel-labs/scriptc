// K16 fixture: the base dynamic-constructor hook a library session needs.
// A DOMException's `.constructor` read goes through the dynamic handle's
// dispatch (scr_json.c's scr_dyn_global_constructor_hook), which only
// answers after the library initializer installs the hook the executable
// entry installs.
export function domexCtorName(): string {
  const error = new DOMException("stopped", "AbortError");
  return error.constructor.name;
}

console.log("dyn-constructors ready");
