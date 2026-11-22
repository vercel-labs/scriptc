import { BOOL, DYN, F64, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The record builtin call slots. */
export const recordSignatures = defineLibFnSignatures({
  /** Object.freeze of a record whose shape is freezable (frozen-records.ts):
   * sets the frozen bit in its rc word (scr_record_freeze). The receiver is
   * any record type. */
  "record.freeze": { argTypes: [null], result: VOID },
  /** Whether a record is frozen: its rc word's frozen bit, set by
   * record.freeze and dyn.freeze of a capsule. Emitted inline. The receiver
   * is any record type. */
  "record.isFrozen": { argTypes: [null], result: BOOL },
  /** Throws Node's TypeError for a write to a frozen record: the key, the
   * object's text in the message ("#<Object>") and the operation (0 assign,
   * 1 add, 2 delete). */
  "record.throwFrozen": { argTypes: [STRING, STRING, F64], result: VOID },
  /* Whether a closed declared-field record kept the undeclared properties
   * of its checked source (scr_record_source_note): reflective surfaces
   * (inspect, Object.keys/values/entries) then answer through its live
   * checked view. The receiver is any such record type. Never throws. */
  "record.sourceHas": { argTypes: [null], result: BOOL },
  /* Whether a closed declared-field record answers reflection from its
   * declared fields alone (scr_record_reflects_static): it kept no source,
   * is no copy linked to a wider source, and no live checked view of it
   * holds a prototype, a member or a symbol-keyed property of its own. The
   * second argument is a boolLit: whether the program narrows any record
   * into this type, the only way to a linked copy. The fast answers of
   * own-key-lists.ts hold exactly then. Never throws. */
  "record.reflectsStatic": { argTypes: [null, BOOL], result: BOOL },
  /** `record.sourceGet(record, name)`: the value the record's kept source
   * holds under `name`, or the undefined value when it keeps none or its
   * source lacks the key (+1). The name is a strLit. A kept accessor runs
   * with the view as its receiver, so a getter that throws leaves the
   * exception pending. */
  "record.sourceGet": { argTypes: [null, STRING], result: DYN },
  /** `record.sourceHasKey(record, name)`: whether the record's kept source
   * holds `name` as an own property (false when it keeps none). The name is
   * a strLit. A conversion tests this before `record.sourceGet` so a key the
   * source lacks leaves the target field absent. Never throws. */
  "record.sourceHasKey": { argTypes: [null, STRING], result: BOOL },
  /** `record.sourceDelete(record, key, strict)`: `delete record.key` of a
   * key the record's declared layout does not hold — the key lives in the
   * record's kept source, and the delete removes it there. Answers
   * `delete`'s boolean (true when the property is gone), and throws
   * Node's TypeError for a frozen record in strict code (`strict` is the
   * delete's own mode). `key` is a constant literal. */
  "record.sourceDelete": { argTypes: [null, STRING, BOOL], result: BOOL },
  /** `record.sourceSpread(built, value)`: the record a literal starting
   * with `...value` just built keeps the order of value's kept source
   * (key-order-witness.ts ordered spreads). Both are record types. Never
   * throws. */
  "record.sourceSpread": { argTypes: [null, null], result: VOID },
  /** `record.sourceShare(built, value)`: the record `built`, of value's
   * record type, keeps value's kept source too (record-links.ts compose
   * helpers). Never throws. */
  "record.sourceShare": { argTypes: [null, null], result: VOID },
  /** `record.link(copy, source, pair)`: the copy a narrowing conversion
   * just built links to its source record (IrModule.recordLinks; `pair`
   * a numLit). Borrows both. Never throws. */
  "record.link": { argTypes: [null, null, F64], result: VOID },
  /** `record.linkIs(copy, pair)`: whether the record links to a source
   * through the pair (a numLit). Never throws. */
  "record.linkIs": { argTypes: [null, F64], result: BOOL },
  /** `record.linkSource(copy, pair)`: the source a record links to
   * through the pair, which the caller has tested (record.linkIs); its
   * type is the pair's source type. Never throws. */
  "record.linkSource": { argTypes: [null, F64], result: VOID },
  /** `record.sourceNote(built, keys)`: the record a spread just built
   * keeps `keys` as its kept source (scr_record_source_note). For a
   * declared spread merge (`{ ...a, ...b }` into one declared shape;
   * key-order-witness.ts declared merges) they are the declared keys its
   * sources supplied, in the order the spreads created them, kept when the
   * record holds them in another order than it serializes them. For a width
   * spread they are the copy's own keys, in order (declared ones are
   * placeholders), kept when they hold an undeclared key or another order.
   * The first is a record type, the second dyn (borrowed). Never throws. */
  "record.sourceNote": { argTypes: [null, DYN], result: VOID },
});
