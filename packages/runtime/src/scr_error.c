/* Error objects: the runtime-provided root of the `extends Error` class
 * hierarchy (layout/vtable contract in scr_runtime.h). Everything here
 * mirrors what the compiler emits for its own hierarchy classes — retain
 * bumps rc (and marks live under the collector), the public release
 * dispatches through the vtable so a base-typed release tears down the
 * derived object, and the direct release in the builtin vtables does the
 * ScrError teardown. The traced/untraced split is a runtime MODE (set by
 * main() from the compiler's cycle fixpoint) because this one compilation
 * unit serves every program.
 */
#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>

static void scr_error_oom(void) {
  scr_trap("scriptc: out of memory\n");
}

static SCR_TL bool scr_error_traced = false;

void scr_error_set_traced(void) { scr_error_traced = true; }

static const char *const scr_error_names[5] = {
    "Error", "TypeError", "RangeError", "SyntaxError",
    /* DOMException's DEFAULT name is "Error" too (WebIDL: the name
     * parameter defaults to "Error"); the class identity lives in the
     * vtable, never the name. */
    "Error"};

void scr_error_trace(void *e, ScrTraceVisit visit, void *ctx) {
  /* name/message are strings — never collector-headered; nothing to visit. */
  (void)e;
  (void)visit;
  (void)ctx;
}

static void scr_error_gcfree(void *obj) {
  ScrError *e = (ScrError *)obj;
  scr_str_release(e->name);
  scr_str_release(e->message);
  scr_str_release(e->code); /* NULL-safe: absent on most errors */
  scr_obj_free_note();
  scr_cyc_free(e);
}

/* DOMException teardown: the ScrError fields plus the owned cause dyn
 * value. The cause is a ScrDyn — scr_json.c territory — and this file
 * must stay linkable WITHOUT the checked-dynamic tree (the runtime C-unit tests link
 * subsets), so the drop goes through a hook scr_json.c installs before
 * any cause can exist (scr_domex_new is the only producer). */
static SCR_TL void (*scr_domex_cause_drop)(void *obj) = NULL;

void scr_domex_install_cause_drop(void (*fn)(void *obj)) {
  scr_domex_cause_drop = fn;
}

static void scr_domex_gcfree(void *obj) {
  ScrDomException *d = (ScrDomException *)obj;
  if (d->cause != NULL && scr_domex_cause_drop != NULL) scr_domex_cause_drop(obj);
  scr_error_gcfree(obj);
}

/* The DIRECT release stored in the builtin vtables (the compiler emits the
 * analogous sc_reld_* for user subclasses). */
static void scr_error_reld(void *obj) {
  ScrError *e = (ScrError *)obj;
  if (--e->rc == 0) {
    if (scr_error_traced) scr_cyc_on_dead(e);
    scr_str_release(e->name);
    scr_str_release(e->message);
    scr_str_release(e->code); /* NULL-safe: absent on most errors */
    scr_obj_free_note();
    if (scr_error_traced) scr_cyc_free(e);
    else free(e);
  } else if (scr_error_traced) {
    scr_cyc_on_release(e); /* possible cycle root; may collect */
  }
}

/* The DOMException vtable's direct release: the cause drops first, then
 * the shared ScrError teardown (through the hook — see scr_domex_gcfree). */
static void scr_domex_reld(void *obj) {
  ScrDomException *d = (ScrDomException *)obj;
  if (d->rc == 1 && d->cause != NULL && scr_domex_cause_drop != NULL) {
    scr_domex_cause_drop(obj);
  }
  scr_error_reld(obj);
}

/* Defaults cover only the instants before main() stamps the program's real
 * preorder intervals; release is permanent. */
SCR_TL ScrVt scr_error_vts[5] = {
    {0, 4, &scr_error_reld}, /* Error */
    {1, 1, &scr_error_reld}, /* TypeError */
    {2, 2, &scr_error_reld}, /* RangeError */
    {3, 3, &scr_error_reld}, /* SyntaxError */
    {4, 4, &scr_domex_reld}, /* DOMException */
};

ScrError *scr_error_retain(ScrError *e) {
  if (e && e->rc != SIZE_MAX) {
    e->rc++;
    if (scr_error_traced) scr_cyc_mark_live(e);
  }
  return e;
}

void scr_error_release(ScrError *e) {
  if (!e || e->rc == SIZE_MAX) return;
  e->vt->release(e); /* the DYNAMIC class's teardown */
}

void *scr_error_retain_v(void *e) { return scr_error_retain((ScrError *)e); }
void scr_error_release_v(void *e) { scr_error_release((ScrError *)e); }

void scr_error_init(void *obj, int kind, ScrStr *message) {
  ScrError *e = (ScrError *)obj;
  const char *n = scr_error_names[kind];
  e->name = scr_str_new(n, strlen(n));
  e->message = message ? scr_str_retain(message) : scr_str_new("", 0);
}

/* The Error hierarchy's trace entry point when the program's cycle fixpoint
 * marked it cycle-capable (NULL otherwise) — the same argument the emitter's
 * throw sites pass. For runtime-side code that stores an Error payload
 * outside a throw (the Promise reject closure in scr_async.c). */
ScrTraceFn scr_error_trace_arg(void) {
  return scr_error_traced ? &scr_error_trace : NULL;
}

/* Mode-aware allocation shared by every runtime-side error creation.
 * DOMException allocates its wider layout (and registers the teardown
 * that drops the cause); calloc/cyc_alloc zeroing covers the extra
 * slots' defaults (code 0, no cause). */
static ScrError *scr_error_alloc(int kind) {
  size_t size = kind == SCR_ERR_DOMEX ? sizeof(ScrDomException) : sizeof(ScrError);
  void (*gcfree)(void *) = kind == SCR_ERR_DOMEX ? &scr_domex_gcfree : &scr_error_gcfree;
  ScrError *e;
  if (scr_error_traced) {
    e = scr_cyc_alloc(size, &scr_error_trace, gcfree);
  } else {
    e = calloc(1, size);
    if (!e) scr_error_oom();
  }
  e->rc = 1;
  e->vt = &scr_error_vts[kind];
  scr_obj_alloc_note();
  return e;
}

ScrError *scr_error_new(int kind, ScrStr *message) {
  ScrError *e = scr_error_alloc(kind);
  scr_error_init(e, kind, message);
  return e;
}

ScrStr *scr_error_to_string(ScrError *e) {
  /* ECMA-262 Error.prototype.toString over the two fields (no prototype
   * chain exists: constructors always initialize both) — except Node's
   * OWN error classes: AssertionError's toString and the NodeError
   * family's construction-time name both render "name [code]: message".
   * Every ERR_*-coded error this runtime mints IS one of those classes
   * (fs/exec errno codes like ENOENT keep the plain form, like Node), so
   * the code-prefix test is exact for runtime-thrown errors; a user
   * assigning an ERR_* code onto a plain Error would bracket here where
   * Node would not (documented — user code owns that spelling). */
  ScrStr *name = e->name;
  ScrStr *message = e->message;
  bool assertion = name && e->code && e->code->len >= 4 &&
                   memcmp(e->code->data, "ERR_", 4) == 0;
  if (!name || name->len == 0) {
    return message ? scr_str_retain(message) : scr_str_new("", 0);
  }
  if (!assertion && (!message || message->len == 0)) return scr_str_retain(name);
  size_t msglen = message ? message->len : 0;
  size_t codelen = assertion ? e->code->len + 3 : 0; /* " [" + code + "]" */
  size_t len = name->len + codelen + 2 + msglen;
  char *buf = malloc(len);
  if (!buf) scr_error_oom();
  size_t n = 0;
  memcpy(buf + n, name->data, name->len);
  n += name->len;
  if (assertion) {
    buf[n++] = ' ';
    buf[n++] = '[';
    memcpy(buf + n, e->code->data, e->code->len);
    n += e->code->len;
    buf[n++] = ']';
  }
  buf[n++] = ':';
  buf[n++] = ' ';
  if (message) memcpy(buf + n, message->data, message->len);
  n += msglen;
  ScrStr *out = scr_str_new(buf, n);
  free(buf);
  return out;
}

bool scr_error_is(const void *obj) {
  const ScrVt *vt = ((const ScrError *)obj)->vt;
  return scr_error_vts[SCR_ERR_ERROR].pre <= vt->pre &&
         vt->pre <= scr_error_vts[SCR_ERR_ERROR].post;
}

void scr_throw_error(int kind, ScrStr *message) {
  ScrError *e = scr_error_new(kind, message);
  scr_str_release(message); /* scr_error_new retained a copy */
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v,
                 scr_error_traced ? &scr_error_trace : NULL);
}

void scr_throw_error_msg(int kind, const char *message, size_t len) {
  scr_throw_error(kind, scr_str_new(message, len));
}

/* ── the `code` slot (NodeJS.ErrnoException's .code) ─────────────────── */

void scr_error_set_code(ScrError *e, const char *code) {
  scr_str_release(e->code); /* NULL-safe; replace is Node's assignment */
  e->code = scr_str_new(code, strlen(code));
}

ScrStr *scr_error_code(ScrError *e) {
  return e->code ? scr_str_retain(e->code) : NULL;
}

ScrStr *scr_error_stack(ScrError *e) {
  return scr_error_to_string(e);
}

/* scr_throw_error_msg with the code stamped on the payload — the fs and
 * exec throwers' one-call spelling. */
void scr_throw_error_msg_code(int kind, const char *message, size_t len,
                               const char *code) {
  ScrStr *msg = scr_str_new(message, len);
  ScrError *e = scr_error_new(kind, msg);
  scr_str_release(msg); /* scr_error_new retained its copy */
  scr_error_set_code(e, code);
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v,
                 scr_error_traced ? &scr_error_trace : NULL);
}

/* A compiler-resolved Node-parity throw (the always-throwing lowered
 * arms: ERR_INVALID_THIS receivers, ERR_MISSING_ARGS ladders, the
 * symbol-to-string TypeError): builds the builtin error of `kind` with
 * `code` stamped when non-empty. Borrows both strings; always throws
 * (catchably — call sites are compiler-emitted pending checks). */
void scr_throw_node_coded(double kind, const ScrStr *code, const ScrStr *msg) {
  ScrError *e = scr_error_new((int)kind, (ScrStr *)msg); /* borrowed in */
  if (code->len > 0) {
    scr_str_release(e->code); /* NULL-safe */
    e->code = scr_str_retain((ScrStr *)code);
  }
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v,
                 scr_error_traced ? &scr_error_trace : NULL);
}

/* A read of a `declare`d const nothing defines (the bundler-define
 * pattern — __VERSION__): Node running the source throws ReferenceError
 * "<name> is not defined" at the access. Borrows `name`; always throws
 * (catchably — callers are compiler-emitted pending checks). */
void scr_undef_global_read(ScrStr *name) {
  static const char suffix[] = " is not defined";
  size_t len = name->len + sizeof suffix - 1;
  char *msg = malloc(len + 1);
  if (!msg) {
    scr_trap("scriptc: out of memory\n");
  }
  memcpy(msg, name->data, name->len);
  memcpy(msg + name->len, suffix, sizeof suffix);
  ScrStr *m = scr_str_new(msg, len);
  free(msg);
  scr_throw_error_named(scr_str_new("ReferenceError", 14), m);
}

/* ── DOMException ─────────────────────────────────────────────────────
 * The web-standard error shape (a Node global since v17): the ScrError
 * prefix plus the WebIDL slots (legacy numeric code, the options form's
 * cause). Construction resolves WebIDL's optionality over borrowed dyn
 * arguments — one place, shared by the compiled `new DOMException(...)`
 * and the runtime's own throw sites (atob/btoa). */

static const struct { const char *name; double code; } scr_domex_codes[] = {
    {"IndexSizeError", 1},             {"DOMStringSizeError", 2},
    {"HierarchyRequestError", 3},      {"WrongDocumentError", 4},
    {"InvalidCharacterError", 5},      {"NoDataAllowedError", 6},
    {"NoModificationAllowedError", 7}, {"NotFoundError", 8},
    {"NotSupportedError", 9},          {"InUseAttributeError", 10},
    {"InvalidStateError", 11},         {"SyntaxError", 12},
    {"InvalidModificationError", 13},  {"NamespaceError", 14},
    {"InvalidAccessError", 15},        {"ValidationError", 16},
    {"TypeMismatchError", 17},         {"SecurityError", 18},
    {"NetworkError", 19},              {"AbortError", 20},
    {"URLMismatchError", 21},          {"QuotaExceededError", 22},
    {"TimeoutError", 23},              {"InvalidNodeTypeError", 24},
    {"DataCloneError", 25},
};

double scr_domex_code_of(const ScrStr *name) {
  for (size_t i = 0; i < sizeof scr_domex_codes / sizeof scr_domex_codes[0]; i++) {
    const char *n = scr_domex_codes[i].name;
    size_t len = strlen(n);
    if (name->len == len && memcmp(name->data, n, len) == 0) {
      return scr_domex_codes[i].code;
    }
  }
  return 0;
}

/* The blank allocation scr_json.c's constructors fill (scr_error_alloc
 * stays private — the mode-aware sizing/teardown selection lives here). */
ScrError *scr_domex_alloc(void) { return scr_error_alloc(SCR_ERR_DOMEX); }

double scr_domex_code(ScrError *e) { return ((ScrDomException *)e)->dom_code; }

bool scr_domex_has_cause(ScrError *e) {
  return ((ScrDomException *)e)->has_cause;
}

void scr_throw_domex(const char *name, const char *message) {
  scr_throw_domex_str(name, scr_str_new(message, strlen(message)));
}

void scr_throw_domex_str(const char *name, ScrStr *message) {
  ScrDomException *d = (ScrDomException *)scr_error_alloc(SCR_ERR_DOMEX);
  d->name = scr_str_new(name, strlen(name));
  d->message = message; /* ownership moves in */
  d->dom_code = scr_domex_code_of(d->name);
  scr_throw_obj(d, &scr_error_retain_v, &scr_error_release_v,
                scr_error_traced ? &scr_error_trace : NULL);
}


void scr_throw_error_named(ScrStr *name, ScrStr *message) {
  int kind = SCR_ERR_ERROR;
  for (int i = 1; i < 4; i++) {
    const char *n = scr_error_names[i];
    if (name->len == strlen(n) && memcmp(name->data, n, name->len) == 0) {
      kind = i;
      break;
    }
  }
  ScrError *e = scr_error_alloc(kind);
  e->name = name;       /* ownership moves in (engine names may be custom) */
  e->message = message; /* ownership moves in */
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v,
                 scr_error_traced ? &scr_error_trace : NULL);
}
