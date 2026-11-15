/* Builtin prototype methods as function values.
 *
 * A JavaScript source reading `String.prototype.trim` (or the Annex B
 * trimLeft/trimRight aliases) fell through the checked-dynamic method table,
 * which has no trim entry, and evaluated the prototype object as a string
 * receiver: `expected string at $, got undefined`. A source reading
 * `RegExp.prototype.exec`, `.test` or `.toString` was refused outright with
 * the SC2020 member fence. This unit answers those members as interned
 * functions — one object per (prototype, member) and thread, the way
 * scr_dyn_invoke.c interns the pieces of the table it owns. They live here
 * rather than in that table because editing the invoke unit changes the
 * bytes of every program that links it; this unit links only into programs
 * that read one of these values (the frontend marks
 * dyn.builtinMethodValue), so every other executable keeps its exact bytes.
 *
 * The String methods are generic exactly as ECMA-262 22.1.3.32-34 define
 * them: RequireObjectCoercible(this), then ToString(this), then the trim. So
 * `trim.call(123)` is "123", an object's toString is observed, and a Symbol
 * is the "Cannot convert a Symbol value to a string" TypeError. Null and
 * undefined are the TypeError Node answers, naming the method.
 *
 * trimLeft IS trimStart and trimRight IS trimEnd (Annex B.2.3.14-15): both
 * spellings are one function object with the standard name and length. The
 * frontend canonicalizes the name before it reaches this unit.
 *
 * The RegExp methods brand-check their receiver the way 22.2.6.2 requires
 * (RequireInternalSlot(R, [[OriginalSource]])), so
 * `RegExp.prototype.exec.call({})` is the TypeError Node answers rather
 * than a wrong match; a native RegExp runs the method it is named for on
 * that receiver, lastIndex state included. `test` follows 22.2.6.3 through
 * RegExpExec: the subject is ToString'ed once and exec is called with that
 * one string, so a receiver whose own `exec` is callable runs that (Node's
 * custom-executor case) and everything else is the brand TypeError. An exec
 * result that is neither null nor an object — undefined included — is the
 * TypeError Node reports.
 * `toString` is generic as 22.2.6.4 defines it — Get(R, "source") and
 * Get(R, "flags") — so it answers "/x/g" for a plain
 * `{ source: "x", flags: "g" }` receiver.
 *
 * `length` is each method's ECMAScript arity (exec and test are 1,
 * toString and the trims are 0), and reading `name`/`length`/`hasOwnProperty`
 * off the value goes through the ordinary dynamic function object: both are
 * own, non-enumerable, non-writable and configurable properties. The
 * frontend emits the same interned value for `RegExp.prototype.exec`,
 * `/a/.exec` and `re.exec`, so their identity matches Node's. */
#include "scr_runtime.h"
#include "scr_dyn_methods.h"

#include <stdio.h>
#include <string.h>

/* The methods, with the `length` every one of them reports. `sig` is the
 * value's signature key: scr_dyn_new_func keeps the pointer and a typed
 * dynCheck strcmp's it later, so every entry is a literal that outlives the
 * call — a signature built in a stack buffer reads freed memory there. */
static const struct {
  const char *owner;
  const char *member;
  uint32_t arity;
  const char *sig;
} bm_methods[] = {
  {"String", "trim", 0, "native:String.prototype"},
  {"String", "trimStart", 0, "native:String.prototype"},
  {"String", "trimEnd", 0, "native:String.prototype"},
  {"RegExp", "exec", 1, "native:RegExp.prototype"},
  {"RegExp", "test", 1, "native:RegExp.prototype"},
  {"RegExp", "toString", 0, "native:RegExp.prototype"},
};

#define BM_COUNT (sizeof bm_methods / sizeof bm_methods[0])

static SCR_TL ScrDyn *bm_values[BM_COUNT];

static void bm_values_cleanup(void) {
  for (size_t i = 0; i < BM_COUNT; i++) {
    scr_dyn_release(bm_values[i]);
    bm_values[i] = NULL;
  }
}

/** Whether `value` is an object in the sense 22.2.6.2's brand check and
 * 22.2.6.4's ToObject-shaped step need: something that can carry an own
 * property. Primitives (including a boxed primitive handle's underlying
 * number/string/boolean) are not. */
static bool bm_is_object(const ScrDyn *value) {
  switch (value->kind) {
    case SCR_DYN_OBJ:
    case SCR_DYN_ARR:
    case SCR_DYN_FUNC:
    case SCR_DYN_HANDLE:
    case SCR_DYN_TYPED_REF:
    case SCR_DYN_PROXY:
    case SCR_DYN_BYTES:
      return true;
    default:
      return false;
  }
}

static void bm_incompatible(const char *owner, const ScrStr *member) {
  char message[128];
  snprintf(message, sizeof message, "Method %s.prototype.%s called on incompatible receiver", owner,
           member->data);
  scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
}

/** One String method run on its receiver: RequireObjectCoercible, then
 * ToString, then the trim named by `member`. */
static ScrDyn *bm_string_call(ScrStr *member, ScrDyn *receiver) {
  if (receiver->kind == SCR_DYN_UNDEF || receiver->kind == SCR_DYN_NULL) {
    char message[80];
    snprintf(message, sizeof message, "String.prototype.%s called on null or undefined",
             member->data);
    scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
    return NULL;
  }
  ScrStr *text = scr_dyn_string_coerce_js(receiver);
  if (!text) return NULL;
  ScrStr *trimmed = !strcmp(member->data, "trimStart") ? scr_str_trim_start(text)
                    : !strcmp(member->data, "trimEnd") ? scr_str_trim_end(text)
                                                       : scr_str_trim(text);
  scr_str_release(text);
  if (!trimmed) return NULL;
  ScrDyn *result = scr_dyn_new_str(trimmed);
  scr_str_release(trimmed);
  return result;
}

/** Whether a value carries the native RegExp brand. scr_regex.c exports
 * scr_dyn_native_regex_is for its own callers, but this unit links into
 * programs that read a method value without ever compiling a regex (a
 * `RegExp.prototype.exec.call({})` is the brand TypeError), so it cannot
 * reference that object; the slot itself is the brand. */
static bool bm_native_regex_is(const ScrDyn *value) {
  return value && value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_REGEXP;
}

/** RegExp.prototype.test's RegExpExec step (22.2.5.2): a native RegExp
 * runs its own exec; any other object runs a callable own `exec`, whose
 * result must be null or an object (undefined is neither). Answers the
 * match row (+1), which may be null, or NULL with the exception pending —
 * and NULL without an exception when the receiver has no callable `exec`,
 * the caller's signal to report the brand TypeError. */
static ScrDyn *bm_regexp_exec_step(ScrDyn *receiver, ScrDyn *const *args, size_t argc) {
  if (bm_native_regex_is(receiver))
    return scr_dyn_invoke(receiver, "exec", args, argc, "exec");
  ScrDyn *exec = scr_dyn_obj_read(receiver, "exec", 4);
  if (!exec) return NULL;
  if (scr_exc_pending() || exec->kind != SCR_DYN_FUNC) {
    scr_dyn_release(exec);
    return NULL;
  }
  ScrDyn *row = scr_dyn_invoke_prepared(receiver, exec, "exec", args, argc, "exec");
  scr_dyn_release(exec);
  if (!row) return NULL;
  if (row->kind != SCR_DYN_NULL && !bm_is_object(row)) {
    static const char message[] =
        "RegExp exec method returned something other than an Object or null";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    scr_dyn_release(row);
    return NULL;
  }
  return row;
}

/** RegExp.prototype.toString (22.2.6.4) for a receiver that is not a
 * native RegExp: "/" + ToString(Get(R, "source")) + "/" + ToString(Get(R,
 * "flags")). */
static ScrDyn *bm_regexp_generic_to_string(ScrDyn *receiver) {
  ScrDyn *source = scr_dyn_obj_read(receiver, "source", 6);
  if (!source) return NULL;
  ScrStr *pattern = scr_dyn_string_coerce_js(source);
  scr_dyn_release(source);
  if (!pattern) return NULL;
  ScrDyn *flag_value = scr_dyn_obj_read(receiver, "flags", 5);
  if (!flag_value) {
    scr_str_release(pattern);
    return NULL;
  }
  ScrStr *flags = scr_dyn_string_coerce_js(flag_value);
  scr_dyn_release(flag_value);
  if (!flags) {
    scr_str_release(pattern);
    return NULL;
  }
  ScrStr *open = scr_str_new("/", 1);
  ScrStr *close = scr_str_new("/", 1);
  ScrStr *parts[4] = {open, pattern, close, flags};
  ScrStr *text = scr_str_concat_parts(parts, 4);
  scr_str_release(open);
  scr_str_release(close);
  scr_str_release(pattern);
  scr_str_release(flags);
  if (!text) return NULL;
  ScrDyn *result = scr_dyn_new_str(text);
  scr_str_release(text);
  return result;
}

/** One RegExp method run on its receiver. `exec` requires the [[OriginalSource]]
 * slot (22.2.6.2); `test` goes through RegExpExec (22.2.6.3); `toString` is
 * generic (22.2.6.4). */
static ScrDyn *bm_regexp_call(ScrStr *member, ScrDyn *receiver, ScrDyn *const *args,
                              size_t argc) {
  if (!strcmp(member->data, "exec")) {
    if (!bm_native_regex_is(receiver)) {
      bm_incompatible("RegExp", member);
      return NULL;
    }
    return scr_dyn_invoke(receiver, "exec", args, argc, "exec");
  }
  if (!strcmp(member->data, "test")) {
    if (!bm_is_object(receiver)) {
      bm_incompatible("RegExp", member);
      return NULL;
    }
    /* 22.2.6.3 step 3: ToString(S) once, before RegExpExec, whether or not
     * the receiver's exec is the native one, and exec is called with that
     * one subject rather than the arguments test received. */
    ScrStr *subject_text = scr_dyn_string_coerce_js(argc > 0 ? args[0] : scr_dyn_undefined());
    if (!subject_text) return NULL;
    ScrDyn *subject = scr_dyn_new_str(subject_text);
    scr_str_release(subject_text);
    if (!subject) return NULL;
    ScrDyn *call_args[1] = {subject};
    ScrDyn *match = bm_regexp_exec_step(receiver, call_args, 1);
    scr_dyn_release(subject);
    if (!match) {
      if (!scr_exc_pending()) bm_incompatible("RegExp", member);
      return NULL;
    }
    bool matched = match->kind != SCR_DYN_NULL;
    scr_dyn_release(match);
    return scr_dyn_new_bool(matched);
  }
  if (bm_native_regex_is(receiver))
    return scr_dyn_invoke(receiver, "toString", args, 0, "toString");
  if (!bm_is_object(receiver)) {
    bm_incompatible("RegExp", member);
    return NULL;
  }
  return bm_regexp_generic_to_string(receiver);
}

/** One builtin prototype method run on its receiver: caps[0] is the
 * prototype ("String", "RegExp") and caps[1] the member name. */
static ScrDyn *bm_method_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  ScrStr *owner = scr_box_get_ref(closure->caps[0]);
  ScrStr *member = scr_box_get_ref(closure->caps[1]);
  ScrDyn *receiver = scr_dyn_this_get();
  ScrDyn *result = NULL;
  if (!strcmp(owner->data, "String")) result = bm_string_call(member, receiver);
  else if (!strcmp(owner->data, "RegExp")) result = bm_regexp_call(member, receiver, args, argc);
  scr_dyn_release(receiver);
  scr_str_release(owner);
  scr_str_release(member);
  return result;
}

/** The (owner, member) method as an interned function; +1. `owner` is
 * "String" or "RegExp" and `member` the canonical spelling the frontend
 * emits. */
ScrDyn *scr_dyn_builtin_method_value(const ScrStr *owner, const ScrStr *member) {
  size_t index = BM_COUNT;
  for (size_t i = 0; i < BM_COUNT; i++) {
    if (!strcmp(bm_methods[i].owner, owner->data) && !strcmp(bm_methods[i].member, member->data)) {
      index = i;
      break;
    }
  }
  if (index == BM_COUNT) {
    /* The frontend marks only the pairs above; anything else is a compiler
     * bug rather than a program's mistake. */
    fprintf(stderr, "scriptc: invalid builtin method value\n");
    abort();
  }
  ScrDyn **slot = &bm_values[index];
  if (*slot) return scr_dyn_retain(*slot);
  ScrStr *owner_name = scr_str_new(bm_methods[index].owner, strlen(bm_methods[index].owner));
  ScrStr *member_name = scr_str_new(bm_methods[index].member, strlen(bm_methods[index].member));
  ScrClosure *closure = scr_closure_new(NULL, 2);
  closure->caps[0] = scr_box_new(SCR_BOX_STR);
  closure->caps[1] = scr_box_new(SCR_BOX_STR);
  scr_box_set_ref(closure->caps[0], scr_str_retain(owner_name));
  scr_box_set_ref(closure->caps[1], scr_str_retain(member_name));
  ScrDyn *value = scr_dyn_new_func(closure, bm_method_call, bm_methods[index].arity,
                                   bm_methods[index].sig, member_name->data);
  scr_str_release(owner_name);
  scr_str_release(member_name);
  *slot = value;
  scr_atexit(bm_values_cleanup);
  return scr_dyn_retain(value);
}
