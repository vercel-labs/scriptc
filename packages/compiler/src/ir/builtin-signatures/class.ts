import { BOOL, DYN, F64, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The class builtin call slots. */
export const classSignatures = defineLibFnSignatures({
  /** Object.defineProperty on a declared class field (scr_json.c): the
   * field's current value (borrowed), its FIELD_* attribute word, the
   * instance's CLASS_* integrity word, the field name and the descriptor.
   * Validates as Node does (TypeError "Cannot redefine property: f") and
   * answers a one-property holder of the defined value and attributes (+1),
   * read back with class.definedBits and class.definedValue. */
  "class.defineField": { argTypes: [DYN, F64, F64, STRING, DYN], result: DYN },
  "class.definedBits": { argTypes: [DYN, STRING], result: F64 },
  "class.definedValue": { argTypes: [DYN, STRING], result: DYN },
  /** Whether a property descriptor has a `value` member. */
  "class.descriptorHasValue": { argTypes: [DYN], result: BOOL },
  /** Throws Node's TypeError for a write to a read-only class field: the
   * field name and the instance's class name. */
  "class.throwReadOnly": { argTypes: [STRING, STRING], result: VOID },
  /** Throws Node's TypeError for a class field initializer on a
   * non-extensible instance: the field name. */
  "class.throwNotExtensible": { argTypes: [STRING], result: VOID },
  // `X.name` through a class value: the arg is a program-dependent
  // classval (a null slot; the libCall case checks the kind).
  /** `X.name` through a class VALUE (scr_object.c): args[0] is a borrowed
   * classval; the result is the class object's stored .name string,
   * retained (+1 — the string is an interned immortal, so the retain is a
   * no-op, kept for ownership uniformity). Never throws. A direct
   * `C.name` on the class name itself folds to a strLit instead. */
  "class.name": { argTypes: [null], result: STRING },
});
