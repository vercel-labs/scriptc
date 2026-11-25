import { arrayOf, BOOL, DYN, F64, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The array builtin call slots. */
export const arraySignatures = defineLibFnSignatures({
  /** Object.freeze of an array (scr_arr_freeze): sets its frozen bit, which
   * the write guards of IrModule.freezableArrays test, and isFrozen reads.
   * The receiver is any array type. */
  "array.freeze": { argTypes: [null], result: VOID },
  "array.isFrozen": { argTypes: [null], result: BOOL },
  // The string keys `for...in` visits on an array (args[0], any element
  // type) after its indices. Borrowed; never throws.
  "array.namedKeys": { argTypes: [null], result: arrayOf(STRING) },
  /** super(...) in a class declared `extends Array`: the instance, the
   * arguments (an array of its element type, or the implicit constructor's
   * dyn argument array) and whether the elements are dyn values. */
  "array.subclassConstruct": { argTypes: [null, null, BOOL], result: VOID },
  "array.subclassConstructDyn": { argTypes: [null, DYN, BOOL], result: VOID },
  /** ArraySpeciesCreate over an Array method's plain result: the receiver
   * (borrowed), the result (moved), the species constructor's length
   * argument (-1: the result's length) and whether to set the length. The
   * result has the second argument's type. */
  "array.speciesAdopt": { argTypes: [null, null, F64, BOOL], result: VOID },
  /** ArraySpeciesCreate ahead of a method that calls back into the program
   * (map, filter, flatMap): the receiver (borrowed) and the species
   * constructor's length argument. The result has the receiver's type: the
   * instance, or the receiver itself when it is a plain array. */
  "array.speciesCreate": { argTypes: [null, F64], result: VOID },
  /** The method's plain result (moved) defined on the instance
   * array.speciesCreate answered (borrowed), and whether to set the length.
   * The result has the second argument's type. */
  "array.speciesFinish": { argTypes: [null, null, BOOL], result: VOID },
  /** Array.of / Array.from on a class declared `extends Array`: the class
   * (its name, a literal), the plain result (moved) and the constructor's
   * length argument (negative: no argument). */
  "array.classConstructAdopt": { argTypes: [STRING, null, F64], result: VOID },
  /** `value instanceof C` for a dyn value and a class that extends Array
   * (its name, a literal). */
  "array.dynIsClass": { argTypes: [DYN, STRING], result: BOOL },
  // The value of the foreign element (SCR_ARR_FOREIGN) at args[1] of an
  // array (args[0], any element type); callers test the element state
  // first. Borrowed; never throws.
  "array.foreign": { argTypes: [null, F64], result: DYN },
  /** The checked conversion's TypeError for the foreign element at args[1]
   * of an array (args[0]) read where a value described by args[2] is
   * expected. ALWAYS THROWS; polymorphic result (the error.nodeThrow
   * pattern). May-throw seed. */
  "array.foreignThrow": { argTypes: [null, F64, STRING], result: VOID },
  // Whether the array (args[0]) still has the key (args[1]) from its
  // namedKeys list. Borrowed; never throws.
  "array.hasNamedKey": { argTypes: [null, STRING], result: BOOL },
  // Whether an array (args[0], any element type) has properties besides its
  // elements: noncanonical numeric keys, match metadata or named
  // properties. Borrowed; never throws.
  "array.hasProperties": { argTypes: [null], result: BOOL },
  // The key of an element access whose index is undefined (the property
  // named "undefined"; frontend/lowering/undefined-index.ts).
  "array.undefinedKey": { argTypes: [], result: F64 },
});
