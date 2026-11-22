import { BIGINT_T, BOOL, DYN, F64, REGEX, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The assert builtin call slots. */
export const assertSignatures = defineLibFnSignatures({
  // node:assert: pass/negated/deep/hasMsg are frontend-computed bools; the
  // message slot always carries a string ("" when hasMsg is false).
  /** node:assert (scr_assert.c; assert.match in scr_regex.c — every call
   * site carries a regex value, so the regex link switch is already on).
   * Failures throw a catchable AssertionError — a runtime %Error whose
   * name is "AssertionError" and whose code slot is "ERR_ASSERTION" — so
   * `instanceof Error`, `.name`, `.message`, and `.code` all answer like
   * Node's. Generated messages are Node's assertion_error.js scalar forms
   * byte-exactly (the short `a !== b` form, the stacked `+ actual
   * - expected` diff with the string `^` indicator, the inline-vs-block
   * not-equal split); composite deep failures carry the header line
   * without the rendered inspect diff (documented divergence).
   *
   * assert.ok: (pass, message) — the frontend computed the truthiness AND
   * the full message (the user's, or the compile-time source-text form —
   * assert.fail lowers here too with pass=false). assert.eqF64/eqBigInt/
   * eqStr/eqBool: (a, b, negated, deep, msg, hasMsg) — Object.is comparison,
   * covering strictEqual/notStrictEqual and the scalar deepStrictEqual
   * pair; msg is a typed dummy ("" literal) when hasMsg is false (Node
   * distinguishes an omitted message from an empty one per operator).
   * assert.deepResult: (equal, negated, msg, hasMsg) — the verdict of a
   * frontend-synthesized structural comparison, turned into Node's throw.
   * assert.sameValue: Object.is over doubles (the deep-equal helpers'
   * number leaf; never throws). assert.match: (s, regex, negated, msg,
   * hasMsg) — a fresh exec from index 0. assert.throwsNone: (rejection,
   * ename, hasEname, msg, hasMsg) — the "Missing expected
   * exception|rejection" throw of assert.throws/rejects whose callback
   * returned (fulfilled) normally, with Node's ` (${expected.name})`
   * detail when the expected class or shape carries a name.
   * assert.throwsMismatch: (expectedName, error) — the wrong-class throw
   * of the assert.throws(fn, ErrorClass) form. assert.eqSym:
   * (a, b, negated, deep, msg, hasMsg) — strict equality over symbol
   * values, pointer identity with v24's "Symbol(desc)" stacked-diff
   * messages (scr_symbol.c, the assert.match pattern — symbol-typed
   * slots already flip the symbol link switch). assert.eqDyn:
   * (a, b, negated, deep, msg, hasMsg) — the whole quartet over
   * checked-dynamic operands (both slots dyn; the frontend boxes a
   * static side with dynFrom first): SameValue for the strict pair over
   * the dyn kinds (boxed-closure identity for functions), the structural
   * dyn walk for the deep pair, with assertion_error.js's messages —
   * scalar forms byte-exact, composites rendered compact:false/sorted
   * through the checked-dynamic tree and diffed with the real myers line printer.
   *
   * The assert.throws(fn, {name/code/message}) shape check
   * (expectedException over the static error surface): shapeBegin
   * stashes the caught error, shapeStr/shapeRe add one expected key each
   * (key ids 0 code / 1 message / 2 name; shapeRe lives in scr_regex.c —
   * its regex argument flips the regex link switch — and tests eagerly
   * so scr_assert.c stays libregexp-free), then shapeEnd throws Node's
   * deep-equal Comparison diff BYTE-EXACTLY (the bounded key set makes
   * the rendering enumerable) or the custom message.
   * assert.throwsRegex: (regex, error, msg, hasMsg) — the
   * assert.throws(fn, /re/) check over String(error), Node's
   * regex-mismatch message. assert.regexErrTest: doesNotReject's
   * regex predicate over String(error) (never throws).
   * assert.unwantedRejection: (error, msg, hasMsg) — doesNotReject's
   * "Got unwanted rejection" throw.
   * assert.ifErrorErr/F64/Str/Bool: assert.ifError's per-type throws
   * ("ifError got unwanted exception: " + the error's message/name or
   * the value's inspection) — the frontend routes null/undefined to a
   * no-op and everything else here (Node throws for falsy values too).
   * All arguments are borrowed. */
  "assert.ok": { argTypes: [BOOL, STRING, BOOL, BOOL], result: VOID },
  /** fail(actual, expected, message|null, operator, has_message): the
   * deprecated form's AssertionError, built by the runtime. */
  "assert.failDeprecated": { argTypes: [DYN, DYN, DYN, DYN, DYN], result: VOID },
  /** DEP0094 for the first deprecated fail call (the events unit). */
  "assert.failDeprecation": { argTypes: [], result: VOID },
  /** The next AssertionError's actual, expected and operator, recorded on
   * a failure branch. */
  "assert.record": { argTypes: [DYN, DYN, STRING], result: VOID },
  "assert.errorNew": {
    argTypes: [DYN],
    result: { kind: "object", className: "%AssertionError" },
  },
  "assert.eqF64": { argTypes: [F64, F64, BOOL, BOOL, STRING, BOOL], result: VOID },
  "assert.eqBigInt": { argTypes: [BIGINT_T, BIGINT_T, BOOL, BOOL, STRING, BOOL], result: VOID },
  "assert.eqStr": { argTypes: [STRING, STRING, BOOL, BOOL, STRING, BOOL], result: VOID },
  "assert.eqBool": { argTypes: [BOOL, BOOL, BOOL, BOOL, STRING, BOOL], result: VOID },
  "assert.deepResult": { argTypes: [BOOL, BOOL, STRING, BOOL], result: VOID },
  "assert.looseDeepResult": { argTypes: [BOOL, BOOL, STRING, BOOL], result: VOID },
  "assert.looseDeepDyn": { argTypes: [DYN, DYN, BOOL, STRING, BOOL], result: VOID },
  "assert.partialDeepDyn": { argTypes: [DYN, DYN, STRING, BOOL], result: VOID },
  "assert.partialDeepResult": { argTypes: [BOOL, BOOL, STRING, BOOL], result: VOID },
  "assert.partialEqDyn": { argTypes: [DYN, DYN], result: BOOL },
  "assert.looseF64Eq": { argTypes: [F64, F64], result: BOOL },
  "assert.sameValue": { argTypes: [F64, F64], result: BOOL },
  // The deep-equality pair memo: both slots are program-dependent
  // (any cycle-capable record/array/map type).
  /* deepStrictEqual's pair memo over cycle-capable types: enter answers
   * true for a pair already being compared (Node's memo — equal cyclic
   * structures compare true); leave pops. */
  "assert.deqEnter": { argTypes: [null, null], result: BOOL },
  "assert.deqLeave": { argTypes: [], result: VOID },
  "assert.match": { argTypes: [STRING, REGEX, BOOL, STRING, BOOL], result: VOID },
  /* expectsError's string-matcher check: a thrown object whose `message`
   * is the matcher string, or the string itself, throws
   * ERR_AMBIGUOUS_ARGUMENT; otherwise returns. */
  "assert.throwsAmbiguous": { argTypes: [DYN, STRING], result: VOID },
  "assert.throwsNone": { argTypes: [BOOL, STRING, BOOL, STRING, BOOL], result: VOID },
  "assert.throwsMismatch": {
    argTypes: [STRING, { kind: "object", className: "%Error" }, STRING, BOOL, BOOL],
    result: VOID,
  },
  "assert.throwsRegex": {
    argTypes: [REGEX, { kind: "object", className: "%Error" }, STRING, BOOL, BOOL],
    result: VOID,
  },
  // Symbol strict equality (pointer identity; scr_symbol.c).
  "assert.eqSym": {
    argTypes: [{ kind: "symbol" }, { kind: "symbol" }, BOOL, BOOL, STRING, BOOL],
    result: VOID,
  },
  // The equality quartet over checked-dynamic operands (the frontend
  // boxes a static side into the checked-dynamic tree first).
  "assert.eqDyn": { argTypes: [DYN, DYN, BOOL, BOOL, STRING, BOOL], result: VOID },
  /** A message argument that is not a string, registered for the next
   * failing assertion (scr_assert_message_value). */
  "assert.messageValue": { argTypes: [DYN, BOOL], result: VOID },
  /** An assert method as a function value, by canonical name. */
  "assert.methodValue": { argTypes: [STRING], result: DYN },
  "assert.messageClear": { argTypes: [], result: VOID },
  "assert.looseResult": { argTypes: [BOOL, BOOL, STRING, STRING, STRING, BOOL], result: VOID },
  // The throws(fn, {shape}) accumulator: begin/slot calls never throw;
  // shapeEnd throws the Comparison diff. The error slot is the
  // %Error-narrowed caught value.
  "assert.shapeBegin": { argTypes: [{ kind: "object", className: "%Error" }], result: VOID },
  "assert.shapeStr": { argTypes: [F64, STRING], result: VOID },
  "assert.shapeRe": { argTypes: [F64, REGEX], result: VOID },
  "assert.shapeEnd": { argTypes: [STRING, BOOL, BOOL], result: VOID },
  "assert.regexErrTest": {
    argTypes: [REGEX, { kind: "object", className: "%Error" }],
    result: BOOL,
  },
  "assert.unwantedRejection": {
    argTypes: [{ kind: "object", className: "%Error" }, STRING, BOOL],
    result: VOID,
  },
  "assert.unwantedError": { argTypes: [STRING, BOOL, STRING, BOOL], result: VOID },
  "assert.noErrorPredicate": { argTypes: [DYN, DYN], result: BOOL },
  "assert.regexDynTest": { argTypes: [REGEX, DYN], result: BOOL },
  /** Node's expectsError over an error-INSTANCE expected (assert.throws/
   * rejects second argument): walk the expected dyn error's keys (name,
   * message, code — the %error marker skipped) and deep-compare each
   * against the caught value's; a mismatch throws the deep-equal
   * AssertionError (scr_assert.c). MAY THROW by design. */
  "assert.expectsErrDyn": { argTypes: [DYN, DYN, STRING, BOOL, BOOL], result: VOID },
  /** A validation function against the caught value (Node's expectedException). */
  "assert.throwsValidate": { argTypes: [DYN, DYN, STRING, STRING, BOOL], result: VOID },
  // assert.ifError's typed entries (always throw; unit args never
  // lower). The error slot is program-dependent — any %Error-hierarchy
  // class, root or subclass (the insp.error precedent, null slot).
  "assert.ifErrorErr": { argTypes: [null], result: VOID },
  "assert.ifErrorF64": { argTypes: [F64], result: VOID },
  "assert.ifErrorStr": { argTypes: [STRING], result: VOID },
  "assert.ifErrorBool": { argTypes: [BOOL], result: VOID },
  "assert.ifErrorDyn": { argTypes: [DYN], result: VOID },
  // Bytes equality: the two value slots are any bytes kind (the frontend
  // gates both sides to ONE static bytes type; the libCall case checks
  // the kind and the pair below).
  "assert.refEqBytes": { argTypes: [null, null, BOOL, BOOL, STRING, BOOL], result: VOID },
  "assert.refEqFn": { argTypes: [null, null, BOOL, STRING, BOOL], result: VOID },
  "assert.bytesDeepEq": { argTypes: [null, null, BOOL], result: BOOL },
  "assert.looseBytesEq": { argTypes: [null, null], result: BOOL },
});
