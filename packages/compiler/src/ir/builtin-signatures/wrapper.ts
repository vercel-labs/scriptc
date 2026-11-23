import { arrayOf, BOOL, DYN, F64, STRING } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The wrapper builtin call slots. */
export const wrapperSignatures = defineLibFnSignatures({
  /** A primitive wrapper object (scr_js_wrapper_new): the kind
   * (0 String, 1 Number, 2 Boolean), the value it converts, and the three
   * constructor values for the prototypes' `constructor`. */
  "wrapper.new": { argTypes: [F64, DYN, DYN, DYN, DYN], result: DYN },
  /** ToObject (scr_js_wrapper_to_object): a wrapper for a primitive, the
   * value for an object, a fresh object for null/undefined; then the
   * three constructor values. */
  "wrapper.toObject": { argTypes: [DYN, DYN, DYN, DYN], result: DYN },
  /** `value instanceof String/Number/Boolean` (scr_js_wrapper_instance_of):
   * the kind's prototype on the value's chain. */
  "wrapper.instanceOf": { argTypes: [DYN, F64], result: BOOL },
  /** Object.prototype.toString with the [[PrimitiveValue]] brands
   * (scr_js_wrapper_object_tag); dyn.objectTag otherwise. */
  "wrapper.objectTag": { argTypes: [DYN], result: STRING },
  /** util.types brands that read the slot (scr_js_wrapper_type_is). */
  "wrapper.typeIs": { argTypes: [DYN, STRING], result: BOOL },
  /** The value unchanged, or the not-supported Error when its own data
   * graph holds a wrapper (scr_js_wrapper_guard; the string names the
   * consumer). guardList checks each element. */
  "wrapper.guard": { argTypes: [DYN, STRING], result: DYN },
  "wrapper.guardList": { argTypes: [arrayOf(DYN), STRING], result: arrayOf(DYN) },
  /** Whether a member value a call read as `name` is the builtin
   * String.prototype method of that name (scr_js_wrapper_is_string_method),
   * and the method's receiver, ToString of the value
   * (scr_js_wrapper_this_string). */
  "wrapper.isStringMethod": { argTypes: [DYN, STRING], result: BOOL },
  "wrapper.thisString": { argTypes: [DYN, STRING], result: DYN },
  /** Boolean.prototype as a value in a JavaScript source: the wrapper
   * unit's Boolean prototype object (the one `new Boolean(v)` instances
   * inherit from), so its valueOf/toString accept a primitive boolean or
   * a Boolean wrapper receiver and throw Node's brand-check TypeError for
   * a foreign one. `constructor` is the compiled Boolean constructor. */
  "wrapper.booleanPrototype": { argTypes: [DYN], result: DYN },
});
