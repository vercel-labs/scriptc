import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the dyn module decided never to throw. */
export const dynNeverThrow: readonly IrLibFn[] = [
  "dyn.moduleClassValue",
  // scr_dyn_native_search_params_is compares the value's kind and handle tag.
  "dyn.nativeSearchParamsIs",
  // scr_dyn_register_class_to_string copies the type key and retains the
  // function in a thread-local table; no program code runs.
  "dyn.registerClassToString",
  // scr_dyn_adoptable compares the value's kind.
  "dyn.adoptable",
  // scr_dyn_function_prototype builds the one anonymous function answering
  // undefined on first use and retains it; no user code runs.
  "dyn.functionPrototype",
  // Emitted inline: the value's tag, its signature literal's length and
  // the literal's last four bytes. No runtime call but strlen.
  "dyn.classValueHash",
  // A search of a constant table by the capsule's key hash, then the key
  // pointer or scr_dyn_typed_ref_is_key, which compares a capsule's type
  // key with a string and allocates nothing.
  "dyn.classCase",
  // Emitted inline but for scr_dyn_typed_ref_brand_is_key, which compares a
  // capsule's type key with a string and allocates nothing.
  "dyn.typedRefBrandIs",
  // A count and a table lookup by the wrapped instance's address.
  "dyn.prototypesReplaced",
  "dyn.prototypeReplaced",
];
