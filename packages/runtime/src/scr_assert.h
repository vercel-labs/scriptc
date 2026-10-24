/* scriptc runtime — node:assert (scr_assert.c). Included by scr_runtime.h,
 * which says where new declarations go. */
#ifndef SCR_ASSERT_H
#define SCR_ASSERT_H

#include "scr_http2.h"

/* ── node:assert (scr_assert.c; scr_assert_match lives in scr_regex.c —
 * it needs the matcher, and every assert.match site carries a regex, so
 * the regex link switch is already on). Failures throw a catchable
 * AssertionError (%Error with name "AssertionError", code
 * "ERR_ASSERTION"); the exception is pending on return, the fs pattern.
 * Generated messages are Node's assertion_error.js scalar forms exactly
 * (the design note atop scr_assert.c lists the documented divergences).
 * All ScrStr/ScrError/ScrRegex arguments are BORROWED. `has_msg`
 * distinguishes an omitted user message from an empty one (Node treats
 * them differently per operator). */
void scr_assert_fail_msg(ScrStr *message); /* takes ownership; always throws */
/* AssertionError properties: a failure path records actual, expected and
 * operator before it throws (scr_assert.c). */
void scr_assert_fail(ScrStr *message, bool generated); /* takes ownership; always throws */
/* The options of the node:assert Assert instance whose call is running:
 * bit 1 is `diff: "full"`, bit 2 is `skipPrototype`. The next AssertionError
 * consumes them; a passing call clears them. */
void scr_assert_set_options(int options);
void scr_assert_clear_options(void);
/* A message argument that is not a string, for the next assertion that
 * fails with SCR_ASSERT_VALUE_MESSAGE as its message (scr_assert.c): an
 * Error (`error`) is thrown as it is, anything else reports String(value).
 * Borrows value; clear drops a registration the call did not consume. */
#define SCR_ASSERT_VALUE_MESSAGE "\x01scriptc:assert-message-value"
void scr_assert_message_value(struct ScrDyn *value, bool error);
void scr_assert_message_clear(void);
/* An assert method as a function value, by canonical name (+1). */
struct ScrDyn *scr_assert_method_value(ScrStr *name);
/* assert.throws/rejects with a validation function: its result must be
 * true (Node's expectedException), else the AssertionError. Borrows all. */
void scr_assert_throws_validate(struct ScrDyn *actual, struct ScrDyn *validate, ScrStr *op,
                                ScrStr *msg, bool has_msg);
bool scr_assert_diff_full(void);
bool scr_assert_skip_prototype(void);
void scr_assert_record(ScrDyn *actual, ScrDyn *expected, const char *op); /* values move in */
void scr_assert_record_dyn(ScrDyn *actual, ScrDyn *expected, ScrStr *op); /* borrows */
const char *scr_assert_eq_operator(bool negated, bool deep);
ScrError *scr_assert_error_new(ScrDyn *options);
/* deepEqual / notDeepEqual (Node's loose deep comparison). */
void scr_assert_loose_deep_dyn(ScrDyn *a, ScrDyn *b, bool negated, ScrStr *msg, bool has_msg);
void scr_assert_loose_deep_result(bool equal, bool negated, ScrStr *msg, bool has_msg);
bool scr_assert_loose_bytes_eq(const ScrBytes *a, const ScrBytes *b);
bool scr_assert_loose_f64_eq(double a, double b);
/* partialDeepStrictEqual (Node's partial deep comparison). */
void scr_assert_partial_deep_dyn(ScrDyn *a, ScrDyn *b, ScrStr *msg, bool has_msg);
void scr_assert_partial_deep_result(bool equal, bool negated, ScrStr *msg, bool has_msg);
bool scr_assert_partial_eq_dyn(const ScrDyn *a, const ScrDyn *b);
ScrStr *scr_assert_inspect_str(const ScrStr *s); /* util.inspect quoting; +1 */
void scr_assert_ok(bool pass, ScrStr *message, bool generated);
bool scr_assert_same_value_f64(double a, double b); /* Object.is */
/* deepStrictEqual over cyclic values: pair memo (enter answers true for
 * a pair already being compared — Node's coinductive memo; leave pops).
 * The compiler-emitted helpers over cycle-capable types wrap with these. */
bool scr_assert_deq_enter(const void *a, const void *b);
void scr_assert_deq_leave(void);
void scr_assert_eq_f64(double a, double b, bool negated, bool deep, ScrStr *msg, bool has_msg);
void scr_assert_eq_str(ScrStr *a, ScrStr *b, bool negated, bool deep, ScrStr *msg, bool has_msg);
void scr_assert_eq_bool(bool a, bool b, bool negated, bool deep, ScrStr *msg, bool has_msg);
/* BigInt scalar equality (scr_bigint_assert.c): included only when both
 * optional runtime families are active, preserving their independent
 * link gates. */
void scr_assert_eq_bigint(ScrBigInt *a, ScrBigInt *b, bool negated, bool deep,
                          ScrStr *msg, bool has_msg);
void scr_assert_deep_result(bool equal, bool negated, ScrStr *msg, bool has_msg);
/* deepStrictEqual's verdict over two typed-array/Buffer values of one
 * static elem kind: brands_eq (Node compares prototypes — Buffer vs
 * Uint8Array differ; a compile-time answer from the two arguments' checker
 * types) AND same element count AND byte-identical storage. Both sides
 * always evaluate (they are ordinary borrowed arguments), so a
 * compile-time brand mismatch still runs their side effects. Never
 * throws. */
bool scr_assert_bytes_deep_eq(const ScrBytes *a, const ScrBytes *b, bool brands_eq);
/* strictEqual/notStrictEqual over bytes values: reference identity
 * (Object.is on objects), with Node's object-comparison headers —
 * "Values have same structure but are not reference-equal:" when the
 * contents (and static brands) match, the reference-equal expectation
 * header otherwise. Header-only messages, the composite stance
 * (SEMANTICS.md 102). Borrows a/b/msg; throws on the failing verdict. */
void scr_assert_ref_eq_bytes(const ScrBytes *a, const ScrBytes *b, bool negated,
                             bool brands_eq, ScrStr *msg, bool has_msg);
/* strictEqual/notStrictEqual over function values: reference identity
 * with the same object-comparison headers (two distinct functions are
 * never structure-equal, so the failing equal form always expects
 * reference equality). Header-only messages (SEMANTICS.md 102). */
void scr_assert_ref_eq_fn(const ScrClosure *a, const ScrClosure *b, bool negated,
                          ScrStr *msg, bool has_msg);
/* The failing-EQUAL-operator message assembler (createErrDiff's scalar
 * slice): exported for the spoke files that carry their own value
 * inspection (scr_symbol.c's symbol comparison — the assert.match
 * precedent). `ia`/`ib` are the inspected actual/expected bytes;
 * `quotes` counts string-typed sides (2 quote chars each, excluded from
 * the 12-char short-form budget); `strings` enables the stacked form's
 * first-difference `^` indicator. Throws; borrows msg. */
void scr_assert_eq_fail(const char *ia, size_t la, const char *ib, size_t lb,
                        int quotes, bool both_zero, bool strings, bool deep,
                        ScrStr *msg, bool has_msg);
/* The failing NOT-equal-operator twin: `insp` is the inspected actual. */
void scr_assert_neq_fail(const char *insp, size_t ilen, bool deep,
                         ScrStr *msg, bool has_msg);
/* strictEqual/notStrictEqual/deepStrictEqual/notDeepStrictEqual where
 * either operand is a checked-dynamic value (the frontend boxes a static
 * side into the checked-dynamic tree first). Strict pair: SameValue over the dyn kinds —
 * Object.is numbers, byte-equal strings, units by kind, node identity
 * for arrays/objects/bytes, BOXED-CLOSURE identity for functions. Deep
 * pair: the structural dyn walk (per-element arrays, key-set objects,
 * brand-aware bytes via the buffer flavor bit, closure identity for
 * functions). Generated messages reproduce assertion_error.js — the
 * scalar simple/stacked forms byte-exactly, composite values rendered
 * compact:false/sorted through the checked-dynamic tree and diffed with the real myers
 * line printer (the design note atop scr_assert.c's dyn section lists
 * the divergences). Borrows everything; throws on the failing verdict. */
void scr_assert_eq_dyn(ScrDyn *a, ScrDyn *b, bool negated, bool deep,
                       ScrStr *msg, bool has_msg);
/* assert.equal/notEqual over the frontend's Abstract Equality verdict;
 * actual/expected are borrowed util.inspect renderings. */
void scr_assert_loose_result(bool equal, bool negated, ScrStr *actual,
                             ScrStr *expected, ScrStr *msg, bool has_msg);
/* assert.throws / assert.rejects whose callback returned (or whose
 * promise fulfilled): "Missing expected exception|rejection" with Node's
 * details — ` (${expected.name})` when the expected class/shape carries a
 * name (has_ename), then `: message` or `.`. */
/* Node's expectsError over an error-INSTANCE expected: the expected dyn
 * error's keys (minus the %error marker) each deep-compare against the
 * caught value's; mismatches throw the deep-equal AssertionError. */
void scr_assert_expects_err_dyn(ScrDyn *actual, ScrDyn *expected, ScrStr *msg, bool has_msg);
void scr_assert_throws_none(bool rejection, ScrStr *ename, bool has_ename,
                            ScrStr *msg, bool has_msg);
void scr_assert_throws_mismatch(ScrStr *expected_name, ScrError *err,
                                ScrStr *msg, bool has_msg, bool rejection);
/* assert.throws(fn, <object shape>) — Node's expectedException over the
 * static error surface (name/message/code). A tiny per-call accumulator:
 * begin stashes the caught error, each slot call adds one expected key
 * (key ids: 0 code, 1 message, 2 name — inspect's SORTED render order),
 * and end runs the comparison, throwing Node's deep-equal Comparison
 * diff (byte-exact: the bounded key set makes the full rendering
 * enumerable) or the custom message. Regex-valued slots enter
 * through scr_regex.c (scr_assert_shape_re) which tests eagerly and
 * stores the verdict + rendered source, so this file stays libregexp-free;
 * scr_assert_shape_actual is its borrowed key-value getter (NULL =
 * absent). Straight-line calls between begin and end — no fiber
 * suspension, so the accumulator is safely a static. */
void scr_assert_shape_begin(ScrError *err);
void scr_assert_shape_str(int key, ScrStr *v);
void scr_assert_shape_slot_re(int key, bool matched, ScrStr *rendered /* moves */);
ScrStr *scr_assert_shape_actual(int key); /* borrowed; NULL = absent */
void scr_assert_shape_end(ScrStr *msg, bool has_msg, bool rejection);
/* assert.doesNotReject whose rejection MATCHED (or had no expected):
 * "Got unwanted rejection[: message].\nActual message: \"...\"". */
void scr_assert_unwanted_rejection(ScrError *err, ScrStr *msg, bool has_msg);
/* No-error assertions share Node's unwanted-exception/rejection message.
 * The frontend reads and coerces actual?.message, preserving getter throws. */
void scr_assert_unwanted_error(ScrStr *actual_message, bool rejection, ScrStr *msg, bool has_msg);
bool scr_assert_no_error_predicate(ScrDyn *predicate, ScrDyn *actual);
bool scr_assert_regex_dyn_test(ScrRegex *re, ScrDyn *actual);
/* assert.ifError over the static surface: throws for ANY value the
 * frontend routes here (Node: everything but null/undefined, falsy
 * included) — "ifError got unwanted exception: " + the error's message
 * (its name when the message is empty — Node reads constructor.name,
 * identical for the builtin hierarchy, SEMANTICS.md 105's stance for
 * subclasses) or the value's inspection. */
void scr_assert_iferror_err(ScrError *err);
void scr_assert_iferror_f64(double x);
void scr_assert_iferror_str(ScrStr *s);
void scr_assert_iferror_bool(bool b);
/* The checked-dynamic argument: dyn-kind dispatch — units pass quietly,
 * %error-marked objects throw with the error's message, everything else
 * with the inspection. */
void scr_assert_iferror_dyn(const ScrDyn *v);
/* assert.match / assert.doesNotMatch (scr_regex.c): RegExp.test semantics,
 * including global/sticky lastIndex transitions. */
void scr_assert_match(ScrStr *s, ScrRegex *re, bool negated, ScrStr *msg, bool has_msg);
/* assert.throws(fn, /regex/) whose thrown ERROR did not match: Node tests
 * String(actual) ("Name: message") and reports the regex-mismatch message
 * with the input inspected (scr_regex.c). Passing calls return. */
void scr_assert_throws_regex(ScrRegex *re, ScrError *err, ScrStr *msg, bool has_msg,
                             bool rejection);
/* assert.throws(fn, {message: /re/, ...}): the regex-valued shape slot —
 * tests the stashed actual key eagerly, stores verdict + rendered
 * /source/flags into the accumulator (scr_regex.c). */
void scr_assert_shape_re(int key, ScrRegex *re);
/* assert.doesNotReject's regex predicate over String(error) — never
 * throws (scr_regex.c). */
bool scr_assert_regex_err_test(ScrRegex *re, ScrError *err);
/* strictEqual/notStrictEqual/deep twins over symbol values: pointer
 * identity (a symbol IS its identity), messages from the symbols'
 * "Symbol(desc)" rendering — string-style stacked diffs with the `^`
 * first-difference indicator, v24 exactly (scr_symbol.c). */
void scr_assert_eq_sym(ScrSym *a, ScrSym *b, bool negated, bool deep,
                       ScrStr *msg, bool has_msg);

#endif /* SCR_ASSERT_H */
