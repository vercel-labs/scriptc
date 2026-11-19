#include "scr_runtime.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* The console object as a value. Its function-valued members are one
 * function object each per thread, so `console.log === console.log` holds
 * and a detached method needs no receiver (Node binds them the same way).
 * The output members format their arguments as Node's own methods do:
 * util.format over whatever the caller passed, one line to stdout or
 * stderr through the direct calls' writers (group indentation included).
 * The other keys answer a function too, so `typeof`, a truthiness probe,
 * a copy into another object and a save-and-restore all see what Node
 * shows; calling one through the value is the named boundary, since only
 * its direct call (or `new console.Console`) has a lowering. createTask is
 * the exception: Node's task object (a plain object whose `run` calls the
 * callback) is built here, so both its direct call and a stored member
 * work. Mutation and console's internal slots stay explicit boundaries. */
typedef struct {
  const char *name;
  const char *surface;
  int target; /* 0 stdout, 1 stderr, -1 no call through the value */
  uint32_t length;
} ScrConsoleMember;

/* Node's own enumeration order of the console object's keys. */
static const ScrConsoleMember scr_console_members[] = {
  {"log", "console.log", 0, 0},
  {"info", "console.info", 0, 0},
  {"debug", "console.debug", 0, 0},
  {"warn", "console.warn", 1, 0},
  {"error", "console.error", 1, 0},
  {"dir", "console.dir", -1, 0},
  {"time", "console.time", -1, 0},
  {"timeEnd", "console.timeEnd", -1, 0},
  {"timeLog", "console.timeLog", -1, 0},
  {"trace", "console.trace", -1, 0},
  {"assert", "console.assert", -1, 0},
  {"clear", "console.clear", -1, 0},
  {"count", "console.count", -1, 0},
  {"countReset", "console.countReset", -1, 0},
  {"group", "console.group", -1, 0},
  {"groupEnd", "console.groupEnd", -1, 0},
  {"table", "console.table", -1, 0},
  {"dirxml", "console.dirxml", -1, 0},
  {"groupCollapsed", "console.groupCollapsed", -1, 0},
  {"Console", "console.Console", -1, 1},
  {"profile", "console.profile", -1, 0},
  {"profileEnd", "console.profileEnd", -1, 0},
  {"timeStamp", "console.timeStamp", -1, 0},
  {"context", "console.context", -1, 1},
  {"createTask", "console.createTask", 2, 0},
};
enum { SCR_CONSOLE_MEMBERS = sizeof scr_console_members / sizeof scr_console_members[0] };

static SCR_TL ScrDyn *scr_console_methods[SCR_CONSOLE_MEMBERS];
static SCR_TL bool scr_console_registered;
static void scr_console_methods_cleanup(void) {
  for (size_t i = 0; i < SCR_CONSOLE_MEMBERS; i++) {
    ScrDyn *method = scr_console_methods[i];
    scr_console_methods[i] = NULL;
    scr_dyn_release(method);
  }
}

/* Node's console.createTask task object: one plain object whose `run`
 * member calls the function it is given and answers that function's
 * result. */
static ScrDyn *scr_console_task_run(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  (void)closure;
  if (argc < 1 || !scr_dyn_is_callable(args[0])) {
    static const char message[] = "First argument must be a function.";
    scr_throw_error_msg(SCR_ERR_ERROR, message, sizeof message - 1);
    return NULL;
  }
  /* Node calls the callback as a plain call: `this` is undefined, not the
   * task the method was read from. */
  scr_dyn_this_push_dyn(scr_dyn_undefined());
  ScrDyn *result = scr_dyn_call(args[0], NULL, 0, "the console task's callback");
  scr_dyn_this_pop();
  return result;
}

static ScrDyn *scr_console_create_task(ScrDyn *const *args, size_t argc) {
  if (argc < 1 || args[0]->kind != SCR_DYN_STR || args[0]->v.str->len == 0) {
    static const char message[] = "First argument must be a non-empty string.";
    scr_throw_error_msg(SCR_ERR_ERROR, message, sizeof message - 1);
    return NULL;
  }
  ScrDyn *task = scr_dyn_new_obj();
  if (!task) return NULL;
  ScrClosure *closure = scr_closure_new(NULL, 0);
  ScrDyn *run = scr_dyn_new_func(closure, scr_console_task_run, 0, "native:console task run", "run");
  if (!run) {
    scr_dyn_release(task);
    return NULL;
  }
  /* The set takes ownership of `run`. */
  scr_dyn_obj_set(task, "run", 3, run);
  return task;
}

static ScrDyn *scr_console_method_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  const ScrConsoleMember *member = &scr_console_members[(size_t)scr_box_get_f64(closure->caps[0])];
  if (member->target == 2) return scr_console_create_task(args, argc);
  if (member->target < 0) {
    char message[96];
    int len = snprintf(message, sizeof message,
                       "Calling %s through a stored value has no lowering; call it directly",
                       member->surface);
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, (size_t)len, "SC2020");
    return NULL;
  }
  ScrInspFormatOptions options;
  scr_insp_format_defaults(&options, member->surface);
  ScrStr *line = scr_insp_format(args, argc, &options);
  if (!line) return NULL;
  ScrLogArg arg = {.tag = SCR_ARG_STR};
  arg.v.s = line;
  if (member->target) scr_console_error(1, &arg);
  else scr_console_log(1, &arg);
  scr_str_release(line);
  return scr_dyn_retain(scr_dyn_undefined());
}

static void *scr_console_retain(void *ptr) { return ptr; }
static void scr_console_release(void *ptr) { (void)ptr; }
static bool scr_console_set(void *ptr, const char *key, size_t len, const ScrDyn *value) {
  (void)ptr; (void)key; (void)len; (void)value;
  static const char message[] = "Mutating the native console has no lowering";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return false;
}
static ScrDyn *scr_console_get(void *ptr, const char *key, size_t len) {
  (void)ptr;
  for (size_t i = 0; i < SCR_CONSOLE_MEMBERS; i++) {
    const char *name = scr_console_members[i].name;
    if (strlen(name) != len || memcmp(name, key, len) != 0) continue;
    if (!scr_console_methods[i]) {
      ScrClosure *closure = scr_closure_new(NULL, 1);
      closure->caps[0] = scr_box_new(SCR_BOX_F64);
      scr_box_set_f64(closure->caps[0], (double)i);
      scr_console_methods[i] = scr_dyn_new_func(closure, scr_console_method_call,
                                                scr_console_members[i].length, "", name);
    }
    return scr_dyn_retain(scr_console_methods[i]);
  }
  static const char *unsupported[] = {"_stdout", "_stderr"};
  for (size_t i = 0; i < sizeof unsupported / sizeof unsupported[0]; i++)
    if (strlen(unsupported[i]) == len && memcmp(unsupported[i], key, len) == 0) {
      static const char message[] = "This stored console member has no lowering";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
      return NULL;
    }
  return scr_dyn_retain(scr_dyn_undefined());
}
static ScrDyn *scr_console_invoke(void *ptr, ScrDyn *self, const char *key, ScrDyn *const *args, size_t argc, const char *what) {
  (void)self;
  ScrDyn *method = scr_console_get(ptr, key, strlen(key));
  if (!method) return NULL;
  ScrDyn *result = scr_dyn_call(method, args, argc, what);
  scr_dyn_release(method);
  return result;
}
ScrDyn *scr_console_native(void) {
  static const ScrDynHandleOps ops = {"console", scr_console_retain, scr_console_release, scr_console_invoke, scr_console_get, scr_console_set, NULL, NULL};
  if (!scr_console_registered) {
    scr_console_registered = true;
    scr_atexit(scr_console_methods_cleanup);
  }
  scr_dyn_handle_install(SCR_DYNH_CONSOLE, &ops);
  return scr_dyn_new_handle(&scr_console_registered, SCR_DYNH_CONSOLE);
}

/* ── node:console Console instances ──────────────────────────────────
 * The handle owns its targets; scr_console_bind (scr_stream.c) attaches
 * writable streams and installs the stream writer. */

static void *scr_console_inst_retain(void *ptr) {
  ((ScrConsoleInst *)ptr)->rc++;
  return ptr;
}

static void scr_console_state_clear(ScrConsoleState *state);

static void scr_console_inst_release(void *ptr) {
  ScrConsoleInst *inst = ptr;
  if (--inst->rc) return;
  scr_console_state_clear(&inst->state);
  if (inst->stream_drop) inst->stream_drop(inst);
  free(inst);
}

/* kWriteToConsole's indentation: the indent before the line and after
 * every newline inside it (the trailing newline excluded). */
static char *scr_console_indent_text(const char *line, size_t *used, size_t indent) {
  size_t n = *used, breaks = 0;
  for (size_t i = 0; i + 1 < n; i++) breaks += line[i] == '\n';
  if (breaks >= (SIZE_MAX - n) / (indent + 1)) scr_trap("scriptc: console output too large\n");
  size_t total = n + indent * (breaks + 1);
  char *out = malloc(total);
  if (!out) scr_trap("scriptc: out of memory\n");
  size_t o = indent;
  memset(out, ' ', indent);
  for (size_t i = 0; i < n; i++) {
    out[o++] = line[i];
    if (line[i] == '\n' && i + 1 < n) {
      memset(out + o, ' ', indent);
      o += indent;
    }
  }
  *used = total;
  return out;
}

/* kWriteToConsole's indentation over a message that has not had its
 * terminator appended yet: the indent before the text and after EVERY
 * newline in it, a trailing one included (Node's
 * `string.replace(/\n/g, "\n" + indent)` then `indent + string`). The
 * rendered-line helper above excludes the final newline instead, which is
 * the shape its caller hands it. */
static char *scr_console_indent_message(const char *line, size_t *used, size_t indent) {
  size_t n = *used, breaks = 0;
  for (size_t i = 0; i < n; i++) breaks += line[i] == '\n';
  if (breaks >= (SIZE_MAX - n) / (indent + 1)) scr_trap("scriptc: console output too large\n");
  size_t total = n + indent * (breaks + 1);
  char *out = malloc(total);
  if (!out) scr_trap("scriptc: out of memory\n");
  size_t o = indent;
  memset(out, ' ', indent);
  for (size_t i = 0; i < n; i++) {
    out[o++] = line[i];
    if (line[i] == '\n') {
      memset(out + o, ' ', indent);
      o += indent;
    }
  }
  *used = total;
  return out;
}

/* text + "\n" to one target, under the instance's own group indentation
 * (Node's kWriteToConsole): a bound stream receives ONE write; process
 * stdio rides the console output path. Borrows text. */
static void scr_console_inst_print(ScrConsoleInst *inst, int which, ScrStr *text) {
  ScrStr *line = text;
  ScrStr *indented = NULL;
  if (inst->state.indent) {
    char *owned = NULL;
    const char *bytes = scr_str_utf8(text, &owned);
    size_t used = text->len;
    char *spaces = scr_console_indent_message(bytes, &used, inst->state.indent);
    scr_str_utf8_end(owned);
    indented = scr_str_new(spaces, used);
    free(spaces);
    line = indented;
  }
  if (inst->stream[which]) {
    ScrStr *nl = scr_str_new("\n", 1);
    ScrStr *written = scr_str_concat(line, nl);
    scr_str_release(nl);
    inst->stream_write(inst, which, written);
    scr_str_release(written);
  } else {
    ScrLogArg arg = {.tag = SCR_ARG_STR};
    arg.v.s = line;
    scr_console_write_fd(inst->fd[which] == 2 ? 2 : 1, 1, &arg, inst->ignore_errors);
  }
  scr_str_release(indented);
}

/* The five output members, in the order the bound-function slots hold them
 * (the same order Node's Console constructor binds them). */
static const char *const scr_console_inst_member_names[] = {"log", "info", "debug", "error", "warn"};

/* 0..4 for the five output members, -1 otherwise. */
static int scr_console_member_index(const char *key, size_t len) {
  for (int i = 0; i < 5; i++)
    if (strlen(scr_console_inst_member_names[i]) == len &&
        memcmp(scr_console_inst_member_names[i], key, len) == 0)
      return i;
  return -1;
}

/* ── bound instance methods ────────────────────────────────────────────
 * Node's Console constructor binds each method to the instance, so
 * `const { log } = consoleInstance` answers a function that writes to that
 * instance's target. Each output member's bound function is built once per
 * instance (identity holds), captures the instance with an owned reference
 * and calls the same invoke path the member's own call takes. The cycle
 * (the instance holds its bound functions, the functions hold the instance)
 * is broken at exit by scr_console_bound_cleanup, before the runtime's
 * reference audit runs. */
static SCR_TL ScrConsoleInst *scr_console_bound_list;

static ScrDyn *scr_console_inst_invoke(void *ptr, ScrDyn *self, const char *key,
                                       ScrDyn *const *args, size_t argc, const char *what);
static ScrDyn *scr_console_inst_bound_call(ScrClosure *closure, ScrDyn *const *args, size_t argc);

static void scr_console_bound_cleanup(void) {
  ScrConsoleInst *inst = scr_console_bound_list;
  scr_console_bound_list = NULL;
  while (inst != NULL) {
    ScrConsoleInst *next = inst->bound_next;
    inst->bound_next = NULL;
    inst->bound_linked = false;
    /* The functions' captured references keep the instance alive until
     * they go, so hold one of our own while they are released. */
    scr_console_inst_retain(inst);
    for (int i = 0; i < 5; i++) {
      ScrDyn *function = inst->bound[i];
      inst->bound[i] = NULL;
      scr_dyn_release(function);
    }
    scr_console_inst_release(inst);
    inst = next;
  }
}

/** The instance's bound function for member `which` (+1), built on first
 * read. */
static ScrDyn *scr_console_inst_bound(ScrConsoleInst *inst, int which) {
  ScrDyn *held = inst->bound[which];
  if (held != NULL) return scr_dyn_retain(held);
  static SCR_TL bool cleanup_registered;
  if (!cleanup_registered) {
    cleanup_registered = true;
    scr_atexit(scr_console_bound_cleanup);
  }
  ScrClosure *closure = scr_closure_new(NULL, 2);
  closure->caps[0] = scr_box_new_obj(scr_console_inst_retain, scr_console_inst_release, NULL);
  scr_box_set_ref(closure->caps[0], scr_console_inst_retain(inst));
  closure->caps[1] = scr_box_new(SCR_BOX_F64);
  scr_box_set_f64(closure->caps[1], (double)which);
  ScrDyn *function = scr_dyn_new_func(closure, scr_console_inst_bound_call, 0, "",
                                      scr_console_inst_member_names[which]);
  if (function == NULL) return NULL;
  inst->bound[which] = scr_dyn_retain(function);
  if (!inst->bound_linked) {
    inst->bound_linked = true;
    inst->bound_next = scr_console_bound_list;
    scr_console_bound_list = inst;
  }
  return function;
}

static ScrDyn *scr_console_inst_bound_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  ScrConsoleInst *inst = scr_box_get_ref(closure->caps[0]); /* +1 */
  int which = (int)scr_box_get_f64(closure->caps[1]);
  if (inst == NULL) return NULL;
  ScrDyn *out = scr_console_inst_invoke(inst, NULL, scr_console_inst_member_names[which], args,
                                        argc, "Console method");
  scr_console_inst_release(inst);
  return out;
}

static ScrDyn *scr_console_inst_get(void *ptr, const char *key, size_t len) {
  int which = scr_console_member_index(key, len);
  if (which >= 0) return scr_console_inst_bound(ptr, which);
  /* Node's Console instances carry no createTask: the global console
   * alone does, so a read here is undefined, not a boundary. */
  if (len == 10 && memcmp(key, "createTask", 10) == 0)
    return scr_dyn_retain(scr_dyn_undefined());
  static const char message[] = "This Console instance member has no lowering";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return NULL;
}

static bool scr_console_inst_set(void *ptr, const char *key, size_t len, const ScrDyn *value) {
  (void)ptr; (void)key; (void)len; (void)value;
  static const char message[] = "Mutating a Console instance has no lowering";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  return false;
}

/* The output members' calls, direct or through the bound value: Node's
 * kWriteToConsole over util.format (format strings included), one line to
 * the instance's target. */
static ScrDyn *scr_console_inst_invoke(void *ptr, ScrDyn *self, const char *key,
                                       ScrDyn *const *args, size_t argc, const char *what) {
  (void)self; (void)what;
  int index = scr_console_member_index(key, strlen(key));
  if (index < 0) return scr_console_inst_get(ptr, key, strlen(key));
  ScrInspFormatOptions options;
  scr_insp_format_defaults(&options, index >= 3 ? "console.error" : "console.log");
  ScrStr *line = scr_insp_format(args, argc, &options);
  if (line == NULL) return NULL;
  scr_console_inst_print(ptr, index >= 3 ? 1 : 0, line);
  scr_str_release(line);
  return scr_dyn_retain(scr_dyn_undefined());
}

/* Node's validateInteger(groupIndentation, 'groupIndentation', 0, 1000): an
 * absent (undefined) value takes the default of 2; anything that is not a
 * number throws ERR_INVALID_ARG_TYPE, and a non-integer or out-of-range
 * number throws ERR_OUT_OF_RANGE (with the value as util.inspect renders
 * it). */
static bool scr_console_group_width(const ScrDyn *value, size_t *out) {
  if (value == NULL || value->kind == SCR_DYN_UNDEF) {
    *out = 2;
    return true;
  }
  if (value->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail("groupIndentation", "of type number", value);
    return false;
  }
  double n = value->v.num;
  bool integer = isfinite(n) && trunc(n) == n;
  if (integer && n >= 0 && n <= 1000) {
    *out = (size_t)n;
    return true;
  }
  char received[48];
  if (n == 0 && signbit(n))
    memcpy(received, "-0", 3);
  else
    scr_num_received(n, received);
  char msg[192];
  int len = snprintf(msg, sizeof msg,
                     "The value of \"groupIndentation\" is out of range. It must be %s. Received %s",
                     integer ? ">= 0 && <= 1000" : "an integer", received);
  scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
  return false;
}

ScrDyn *scr_console_new(double out_fd, double err_fd, bool ignore_errors,
                        ScrDyn *group_indentation) {
  static const ScrDynHandleOps ops = {"console", scr_console_inst_retain, scr_console_inst_release,
                                      scr_console_inst_invoke, scr_console_inst_get,
                                      scr_console_inst_set, NULL, NULL};
  scr_dyn_handle_install(SCR_DYNH_CONSOLE_INSTANCE, &ops);
  size_t width = 2;
  if (!scr_console_group_width(group_indentation, &width)) return NULL;
  ScrConsoleInst *inst = calloc(1, sizeof *inst);
  if (!inst) scr_trap("scriptc: out of memory\n");
  inst->rc = 1;
  inst->fd[0] = out_fd;
  inst->fd[1] = err_fd;
  inst->ignore_errors = ignore_errors;
  inst->state.width = width;
  ScrDyn *d = scr_dyn_new_handle(inst, SCR_DYNH_CONSOLE_INSTANCE); /* retains */
  scr_console_inst_release(inst);
  return d;
}

void scr_console_inst_write(ScrDyn *console, ScrStr *text, bool to_stderr) {
  if (console->kind == SCR_DYN_HANDLE && console->v.handle.tag == SCR_DYNH_CONSOLE_INSTANCE) {
    scr_console_inst_print(console->v.handle.ptr, to_stderr ? 1 : 0, text);
    return;
  }
  if (console->kind == SCR_DYN_HANDLE && console->v.handle.tag == SCR_DYNH_CONSOLE) {
    ScrLogArg arg = {.tag = SCR_ARG_STR};
    arg.v.s = text;
    if (to_stderr) scr_console_error(1, &arg);
    else scr_console_log(1, &arg);
    return;
  }
  static const char message[] = "This Console value has no lowering";
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
}

/* Only programs that expose a stored global need its console provider.
 * Keep the core builtin unit independent of optional inspection code. */
ScrDyn *scr_global_native(ScrArr *known) {
  return scr_global_native_init(known, scr_console_native);
}

/* ── console counters, timers, groups, and table ──────────────────────
 * Node keeps these per Console instance. The global console owns one
 * per-thread state (workers own their console), and every Console instance
 * owns one of the same shape (scr_blob.h's ScrConsoleState), so a counter
 * or a group opened on one console never leaks into another. Labels are
 * compared by their string form; the stores are tiny linear tables, as a
 * program holds a handful of labels at a time. */

static SCR_TL ScrConsoleState scr_console_global_state = {.width = 2};
static SCR_TL bool scr_console_stores_registered;

static void scr_console_store_clear(ScrConsoleStore *store) {
  for (size_t i = 0; i < store->len; i++) scr_str_release(store->slots[i].label);
  free(store->slots);
  store->slots = NULL;
  store->len = store->cap = 0;
}

static void scr_console_state_clear(ScrConsoleState *state) {
  scr_console_store_clear(&state->counts);
  scr_console_store_clear(&state->timers);
}

static void scr_console_stores_cleanup(void) {
  scr_console_state_clear(&scr_console_global_state);
}

static ScrConsoleSlot *scr_console_find(ScrConsoleStore *store, const ScrStr *label) {
  for (size_t i = 0; i < store->len; i++) {
    ScrStr *key = store->slots[i].label;
    if (key->len == label->len && memcmp(key->data, label->data, label->len) == 0)
      return &store->slots[i];
  }
  return NULL;
}

static ScrConsoleSlot *scr_console_add(ScrConsoleStore *store, ScrStr *label) {
  if (!scr_console_stores_registered) {
    scr_console_stores_registered = true;
    scr_atexit(scr_console_stores_cleanup);
  }
  if (store->len == store->cap) {
    size_t cap = store->cap ? store->cap * 2 : 4;
    ScrConsoleSlot *slots = realloc(store->slots, cap * sizeof *slots);
    if (!slots) scr_trap("scriptc: out of memory\n");
    store->slots = slots;
    store->cap = cap;
  }
  ScrConsoleSlot *slot = &store->slots[store->len++];
  slot->label = scr_str_retain(label);
  slot->count = 0;
  slot->started = 0;
  return slot;
}

static void scr_console_remove(ScrConsoleStore *store, ScrConsoleSlot *slot) {
  scr_str_release(slot->label);
  size_t at = (size_t)(slot - store->slots);
  memmove(slot, slot + 1, (store->len - at - 1) * sizeof *slot);
  store->len--;
}

/* One line through the global console's stdout writer (group indentation
 * included). Borrows text. */
static void scr_console_print(ScrStr *text) {
  ScrLogArg arg = {.tag = SCR_ARG_STR};
  arg.v.s = text;
  scr_console_log(1, &arg);
}

/* `${label}` after the `label = 'default'` default. */
ScrStr *scr_console_label(ScrDyn *label) {
  if (label->kind == SCR_DYN_UNDEF) return scr_str_new("default", 7);
  ScrStr *text = scr_dyn_string_coerce_js(label);
  return text ? text : scr_str_new("", 0);
}

/* console.count's line: "label: n". +1. */
static ScrStr *scr_console_count_text(ScrConsoleStore *counts, ScrStr *label) {
  ScrConsoleSlot *slot = scr_console_find(counts, label);
  if (!slot) slot = scr_console_add(counts, label);
  slot->count++;
  char digits[40];
  size_t n = scr_f64_to_str(slot->count, digits);
  size_t total = label->len + 2 + n;
  char *line = malloc(total);
  if (!line) scr_trap("scriptc: out of memory\n");
  memcpy(line, label->data, label->len);
  memcpy(line + label->len, ": ", 2);
  memcpy(line + label->len + 2, digits, n);
  ScrStr *text = scr_str_new(line, total);
  free(line);
  return text;
}

void scr_console_count(ScrStr *label) {
  ScrStr *text = scr_console_count_text(&scr_console_global_state.counts, label);
  scr_console_print(text);
  scr_str_release(text);
}

/* "<prefix><label><suffix>" — the warning texts. */
static ScrStr *scr_console_message(const char *prefix, const ScrStr *label, const char *suffix) {
  size_t a = strlen(prefix), c = strlen(suffix);
  size_t total = a + label->len + c;
  char *text = malloc(total ? total : 1);
  if (!text) scr_trap("scriptc: out of memory\n");
  memcpy(text, prefix, a);
  memcpy(text + a, label->data, label->len);
  memcpy(text + a + label->len, suffix, c);
  ScrStr *out = scr_str_new(text, total);
  free(text);
  return out;
}

/* console.countReset: Node looks the raw label up (`counts.has(label)`),
 * so only string labels (and the default) can match; the warning names
 * the label's string form. */
static ScrStr *scr_console_count_reset_impl(ScrConsoleStore *counts, ScrDyn *label) {
  ScrStr *text = scr_console_label(label);
  if (scr_exc_pending()) return text;
  bool keyed = label->kind == SCR_DYN_UNDEF || label->kind == SCR_DYN_STR;
  ScrConsoleSlot *slot = keyed ? scr_console_find(counts, text) : NULL;
  if (slot) {
    scr_console_remove(counts, slot);
    scr_str_release(text);
    return scr_str_new("", 0);
  }
  ScrStr *message = scr_console_message("Count for '", text, "' does not exist");
  scr_str_release(text);
  return message;
}

ScrStr *scr_console_count_reset(ScrDyn *label) {
  return scr_console_count_reset_impl(&scr_console_global_state.counts, label);
}

static ScrStr *scr_console_time_impl(ScrConsoleStore *timers, ScrStr *label) {
  if (scr_console_find(timers, label))
    return scr_console_message("Label '", label, "' already exists for console.time()");
  scr_console_add(timers, label)->started = scr_hrtime_ns();
  return scr_str_new("", 0);
}

ScrStr *scr_console_time(ScrStr *label) {
  return scr_console_time_impl(&scr_console_global_state.timers, label);
}

static size_t scr_console_pad2(double value, char *out) {
  char digits[40];
  size_t n = scr_f64_to_str(value, digits);
  size_t o = 0;
  if (n < 2) out[o++] = '0';
  memcpy(out + o, digits, n);
  return o + n;
}

/* lib/internal/util/debuglog.js formatTime. */
static ScrStr *scr_console_format_time(double ms) {
  double hours = 0, minutes = 0, seconds = 0;
  if (ms >= 1000) {
    if (ms >= 60000) {
      if (ms >= 3600000) {
        hours = floor(ms / 3600000);
        ms = fmod(ms, 3600000);
      }
      minutes = floor(ms / 60000);
      ms = fmod(ms, 60000);
    }
    seconds = ms / 1000;
  }
  char buf[256];
  size_t o = 0;
  if (hours != 0 || minutes != 0) {
    char fixed[128];
    size_t fn = scr_f64_to_fixed(seconds, 3, fixed);
    fixed[fn] = '\0';
    char *dot = strchr(fixed, '.');
    size_t whole = dot ? (size_t)(dot - fixed) : fn;
    if (hours != 0) {
      o += scr_f64_to_str(hours, buf + o);
      buf[o++] = ':';
      o += scr_console_pad2(minutes, buf + o);
    } else {
      o += scr_f64_to_str(minutes, buf + o);
    }
    buf[o++] = ':';
    if (whole < 2) buf[o++] = '0';
    memcpy(buf + o, fixed, whole);
    o += whole;
    buf[o++] = '.';
    if (dot) {
      size_t frac = fn - whole - 1;
      memcpy(buf + o, dot + 1, frac);
      o += frac;
    }
    const char *unit = hours != 0 ? " (h:mm:ss.mmm)" : " (m:ss.mmm)";
    memcpy(buf + o, unit, strlen(unit));
    o += strlen(unit);
    return scr_str_new(buf, o);
  }
  if (seconds != 0) {
    o = scr_f64_to_fixed(seconds, 3, buf);
    buf[o++] = 's';
    return scr_str_new(buf, o);
  }
  char fixed[128];
  size_t fn = scr_f64_to_fixed(ms, 3, fixed);
  fixed[fn] = '\0';
  o = scr_f64_to_str(strtod(fixed, NULL), buf);
  memcpy(buf + o, "ms", 2);
  return scr_str_new(buf, o + 2);
}

static ScrStr *scr_console_elapsed_impl(ScrConsoleStore *timers, ScrStr *label, bool end) {
  ScrConsoleSlot *slot = scr_console_find(timers, label);
  if (!slot) return scr_str_new("", 0);
  /* process.hrtime(start): [seconds, nanoseconds], then
   * seconds * 1000 + nanoseconds / 1e6. */
  uint64_t elapsed = scr_hrtime_ns() - slot->started;
  double ms = (double)(elapsed / 1000000000u) * 1000 + (double)(elapsed % 1000000000u) / 1e6;
  if (end) scr_console_remove(timers, slot);
  return scr_console_format_time(ms);
}

ScrStr *scr_console_time_end(ScrStr *label) {
  return scr_console_elapsed_impl(&scr_console_global_state.timers, label, true);
}

ScrStr *scr_console_time_log(ScrStr *label) {
  return scr_console_elapsed_impl(&scr_console_global_state.timers, label, false);
}

/* Node's kGroupIndentationString: groupIndentationWidth spaces per open
 * group (the global console keeps its default of two). */
static void scr_console_state_group(ScrConsoleState *state, double delta) {
  if (delta > 0) state->indent += state->width;
  else if (state->indent >= state->width) state->indent -= state->width;
}

/* kWriteToConsole's indentation over the global console's rendered lines. */
static char *scr_console_indent_line(const char *line, size_t *used) {
  return scr_console_indent_text(line, used, scr_console_global_state.indent);
}

void scr_console_group(double delta) {
  scr_console_state_group(&scr_console_global_state, delta);
  scr_console_indenter = scr_console_global_state.indent ? scr_console_indent_line : NULL;
}

/* Only a terminal stdout clears (TERM=dumb excepted): readline's
 * cursorTo(stdout, 0, 0), then clearScreenDown(stdout). */
static void scr_console_clear_tty(int fd) {
  if (!scr_process_is_tty(fd)) return;
  const char *term = getenv("TERM");
  if (term && strcmp(term, "dumb") == 0) return;
  scr_stdio_write_text(fd, "\x1b[1;1H", 6);
  scr_stdio_write_text(fd, "\x1b[0J", 4);
}

void scr_console_clear(void) { scr_console_clear_tty(1); }

/* ── the same members on a Console instance ───────────────────────────
 * Node's Console keeps its own counters, timers and group indentation and
 * writes every line to its own streams; each entry here reads the
 * instance's state. */

static ScrConsoleInst *scr_console_inst_of(ScrDyn *console, const char *surface) {
  if (console->kind == SCR_DYN_HANDLE && console->v.handle.tag == SCR_DYNH_CONSOLE_INSTANCE)
    return console->v.handle.ptr;
  char message[96];
  int len = snprintf(message, sizeof message, "Calling %s on this value has no lowering", surface);
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, (size_t)len, "SC2020");
  return NULL;
}

void scr_console_inst_count(ScrDyn *console, ScrStr *label) {
  ScrConsoleInst *inst = scr_console_inst_of(console, "console.count");
  if (!inst) return;
  ScrStr *text = scr_console_count_text(&inst->state.counts, label);
  scr_console_inst_print(inst, 0, text);
  scr_str_release(text);
}

ScrStr *scr_console_inst_count_reset(ScrDyn *console, ScrDyn *label) {
  ScrConsoleInst *inst = scr_console_inst_of(console, "console.countReset");
  if (!inst) return scr_str_new("", 0);
  return scr_console_count_reset_impl(&inst->state.counts, label);
}

ScrStr *scr_console_inst_time(ScrDyn *console, ScrStr *label) {
  ScrConsoleInst *inst = scr_console_inst_of(console, "console.time");
  if (!inst) return scr_str_new("", 0);
  return scr_console_time_impl(&inst->state.timers, label);
}

ScrStr *scr_console_inst_time_end(ScrDyn *console, ScrStr *label) {
  ScrConsoleInst *inst = scr_console_inst_of(console, "console.timeEnd");
  if (!inst) return scr_str_new("", 0);
  return scr_console_elapsed_impl(&inst->state.timers, label, true);
}

ScrStr *scr_console_inst_time_log(ScrDyn *console, ScrStr *label) {
  ScrConsoleInst *inst = scr_console_inst_of(console, "console.timeLog");
  if (!inst) return scr_str_new("", 0);
  return scr_console_elapsed_impl(&inst->state.timers, label, false);
}

void scr_console_inst_group(ScrDyn *console, double delta) {
  ScrConsoleInst *inst = scr_console_inst_of(console, "console.group");
  if (inst) scr_console_state_group(&inst->state, delta);
}

void scr_console_inst_clear(ScrDyn *console) {
  ScrConsoleInst *inst = scr_console_inst_of(console, "console.clear");
  if (!inst) return;
  /* A bound writable carries no terminal: Node's isTTY is undefined. */
  if (inst->stream[0]) return;
  scr_console_clear_tty(inst->fd[0] == 2 ? 2 : 1);
}

/* console.trace on an instance: "Trace[: text]" and the captured frames,
 * written to the instance's stderr as one chunk, under its indentation.
 * The frames are scriptc's own function and file text (SEMANTICS.md
 * divergence 11). Borrows text. */
void scr_console_inst_trace(ScrDyn *console, ScrStr *text) {
  ScrConsoleInst *inst = scr_console_inst_of(console, "console.trace");
  if (!inst) return;
  ScrStr *head = text->len == 0 ? scr_str_new("Trace", 5) : scr_str_new("Trace: ", 7);
  ScrStr *body = scr_str_concat(head, text);
  ScrStr *frames = scr_stack_capture();
  ScrStr *line = frames ? scr_str_concat(body, frames) : scr_str_retain(body);
  scr_console_inst_print(inst, 1, line);
  scr_str_release(line);
  scr_str_release(frames);
  scr_str_release(body);
  scr_str_release(head);
}

/* console.dir over a dyn value: inspect with custom inspection off. The
 * only custom inspection the dyn walk applies is a Buffer's <Buffer ..>
 * form, so a Buffer anywhere inside is refused. */
static bool scr_console_holds_buffer(const ScrDyn *d) {
  switch (d->kind) {
    case SCR_DYN_BYTES:
      return d->buffer;
    case SCR_DYN_PROXY:
      return scr_console_holds_buffer(d->v.proxy.target);
    case SCR_DYN_ARR:
      for (size_t i = 0; i < d->v.arr.len; i++)
        if (scr_console_holds_buffer(d->v.arr.items[i])) return true;
      return false;
    case SCR_DYN_OBJ:
      for (size_t i = 0; i < scr_dyn_obj_count(d); i++) {
        const ScrDyn *value = scr_dyn_obj_value_at(d, i);
        if (value && scr_console_holds_buffer(value)) return true;
      }
      return false;
    default:
      return false;
  }
}

ScrStr *scr_console_dir_dyn(ScrDyn *value, double depth) {
  if (scr_console_holds_buffer(value)) {
    static const char message[] = "console.dir of a Buffer has no lowering";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    return scr_str_new("", 0);
  }
  /* console.dir is inspect with customInspect: false. */
  bool custom = scr_insp_custom_inspect(false);
  ScrStr *out = scr_insp_dyn(value, 0, depth);
  scr_insp_custom_inspect(custom);
  return out;
}

/* console.dir with showHidden: the checked-dynamic walk's hidden entries,
 * with custom inspection still off (dir's default). */
ScrStr *scr_console_dir_hidden(ScrDyn *value, double depth) {
  if (scr_console_holds_buffer(value)) {
    static const char message[] = "console.dir of a Buffer has no lowering";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    return scr_str_new("", 0);
  }
  return scr_insp_dyn_hidden_as(value, depth, "console.dir", false, 0);
}

/* ── console.table ───────────────────────────────────────────────────
 * Node's table(): the index column holds the data's own keys, one column
 * per property seen across the rows (or the properties argument), and a
 * Values column for primitive rows; cells are _inspect renderings
 * (scr_insp_table_cell). The layout is lib/internal/cli_table.js. */

typedef struct {
  ScrStr *key;
  ScrStr **cells; /* one per row; NULL = no own property ('') */
} ScrTableColumn;

typedef struct {
  ScrTableColumn *cols;
  size_t len, cap, rows;
} ScrTable;

static void scr_table_fence(const char *message) {
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, strlen(message), "SC2020");
}

/* A canonical array index ("0", "17"; no sign, no leading zeros, below
 * 2^32 - 1): the keys JS orders first, ascending. */
static bool scr_table_index_key(const char *key, size_t len, uint32_t *out) {
  if (len == 0 || len > 10 || (len > 1 && key[0] == '0')) return false;
  uint64_t value = 0;
  for (size_t i = 0; i < len; i++) {
    if (key[i] < '0' || key[i] > '9') return false;
    value = value * 10 + (uint64_t)(key[i] - '0');
  }
  if (value >= 4294967295u) return false;
  *out = (uint32_t)value;
  return true;
}

/* Object.keys order over n keys: index keys ascending, then the rest in
 * insertion order. Fills order[] with positions. */
static void scr_table_key_order(const char *const *keys, const size_t *lens, size_t n, size_t *order) {
  size_t o = 0;
  for (size_t i = 0; i < n; i++) {
    uint32_t index;
    if (!scr_table_index_key(keys[i], lens[i], &index)) continue;
    size_t at = o++;
    while (at > 0) {
      uint32_t prev;
      scr_table_index_key(keys[order[at - 1]], lens[order[at - 1]], &prev);
      if (prev <= index) break;
      order[at] = order[at - 1];
      at--;
    }
    order[at] = i;
  }
  for (size_t i = 0; i < n; i++) {
    uint32_t index;
    if (!scr_table_index_key(keys[i], lens[i], &index)) order[o++] = i;
  }
}

static ScrDyn *scr_table_view(ScrDyn *d) {
  while (d->kind == SCR_DYN_PROXY) d = d->v.proxy.target;
  if (d->kind == SCR_DYN_TYPED_REF) return scr_dyn_typed_ref_materialize(d);
  return scr_dyn_retain(d);
}

static bool scr_table_primitive(const ScrDyn *d) {
  switch (d->kind) {
    case SCR_DYN_NULL:
    case SCR_DYN_UNDEF:
    case SCR_DYN_BOOL:
    case SCR_DYN_NUM:
    case SCR_DYN_STR:
    case SCR_DYN_BIGINT:
    case SCR_DYN_SYMBOL:
      return true;
    default:
      return false;
  }
}

static ScrStr *scr_table_index_text(size_t i) {
  char digits[24];
  int n = snprintf(digits, sizeof digits, "%zu", i);
  return scr_str_new(digits, (size_t)n);
}

/* The own enumerable keys of a row (Object.keys), as owned strings. */
static ScrStr **scr_table_own_keys(const ScrDyn *item, size_t *count) {
  *count = 0;
  if (item->kind == SCR_DYN_ARR || item->kind == SCR_DYN_BYTES) {
    size_t len = item->kind == SCR_DYN_ARR ? item->v.arr.len : item->v.bytes->len;
    ScrStr **keys = calloc(len ? len : 1, sizeof *keys);
    if (!keys) scr_trap("scriptc: out of memory\n");
    for (size_t i = 0; i < len; i++) keys[i] = scr_table_index_text(i);
    *count = len;
    return keys;
  }
  if (item->kind != SCR_DYN_OBJ) return NULL;
  size_t len = scr_dyn_obj_count(item);
  const char **names = calloc(len ? len : 1, sizeof *names);
  size_t *lens = calloc(len ? len : 1, sizeof *lens);
  size_t *order = calloc(len ? len : 1, sizeof *order);
  ScrStr **keys = calloc(len ? len : 1, sizeof *keys);
  if (!names || !lens || !order || !keys) scr_trap("scriptc: out of memory\n");
  size_t n = 0;
  for (size_t i = 0; i < len; i++) {
    ScrDynProp prop = scr_dyn_obj_prop_at(item, i);
    if (!prop.enumerable) continue;
    names[n] = prop.key;
    lens[n] = prop.key_len;
    n++;
  }
  scr_table_key_order(names, lens, n, order);
  for (size_t i = 0; i < n; i++) keys[i] = scr_str_new(names[order[i]], lens[order[i]]);
  free(names);
  free(lens);
  free(order);
  *count = n;
  return keys;
}

/* item[key] when it is an own property; NULL otherwise. +1. */
static ScrDyn *scr_table_own_value(const ScrDyn *item, const ScrStr *key) {
  if (item->kind == SCR_DYN_OBJ) {
    size_t i = scr_dyn_obj_index_of(item, key->data, key->len);
    if (i == SIZE_MAX) return NULL;
    ScrDynProp prop = scr_dyn_obj_prop_at(item, i);
    if (prop.accessor) {
      scr_table_fence("console.table rows with accessor properties have no lowering");
      return NULL;
    }
    return scr_dyn_retain(prop.value);
  }
  if (item->kind == SCR_DYN_ARR || item->kind == SCR_DYN_BYTES) {
    size_t len = item->kind == SCR_DYN_ARR ? item->v.arr.len : item->v.bytes->len;
    if (key->len == 6 && memcmp(key->data, "length", 6) == 0) return scr_dyn_new_num((double)len);
    uint32_t index;
    if (!scr_table_index_key(key->data, key->len, &index) || index >= len) return NULL;
    if (item->kind == SCR_DYN_ARR) return scr_dyn_retain(item->v.arr.items[index]);
#ifdef SCR_JS_OBJECT_MODEL
    /* A row's typed array can be a BigInt view; this build of the unit reads
     * the element through the typed-array accessor, the default one keeps the
     * numeric read. */
    return scr_dyn_bytes_item(item->v.bytes, index);
#else
    return scr_dyn_new_num(scr_bytes_get(item->v.bytes, (double)index));
#endif
  }
  return NULL;
}

static ScrTableColumn *scr_table_column(ScrTable *t, ScrStr *key) {
  for (size_t i = 0; i < t->len; i++) {
    ScrStr *k = t->cols[i].key;
    if (k->len == key->len && memcmp(k->data, key->data, key->len) == 0) return &t->cols[i];
  }
  if (t->len == t->cap) {
    size_t cap = t->cap ? t->cap * 2 : 8;
    ScrTableColumn *cols = realloc(t->cols, cap * sizeof *cols);
    if (!cols) scr_trap("scriptc: out of memory\n");
    t->cols = cols;
    t->cap = cap;
  }
  ScrTableColumn *col = &t->cols[t->len++];
  col->key = scr_str_retain(key);
  col->cells = calloc(t->rows ? t->rows : 1, sizeof *col->cells);
  if (!col->cells) scr_trap("scriptc: out of memory\n");
  return col;
}

static void scr_table_column_free(ScrTableColumn *col, size_t rows) {
  if (col->key) scr_str_release(col->key);
  for (size_t j = 0; j < rows; j++) if (col->cells[j]) scr_str_release(col->cells[j]);
  free(col->cells);
}

typedef struct {
  char *data;
  size_t len, cap;
} ScrTableBuf;

static void scr_tb_put(ScrTableBuf *b, const char *data, size_t len) {
  if (b->len + len > b->cap) {
    size_t cap = b->cap ? b->cap : 256;
    while (cap < b->len + len) cap *= 2;
    char *grown = realloc(b->data, cap);
    if (!grown) scr_trap("scriptc: out of memory\n");
    b->data = grown;
    b->cap = cap;
  }
  memcpy(b->data + b->len, data, len);
  b->len += len;
}

static void scr_tb_cstr(ScrTableBuf *b, const char *s) { scr_tb_put(b, s, strlen(s)); }

static void scr_tb_repeat(ScrTableBuf *b, const char *s, size_t times) {
  for (size_t i = 0; i < times; i++) scr_tb_cstr(b, s);
}

static size_t scr_table_width(const ScrStr *s) {
  return s ? scr_insp_display_width(s->data, s->len) : 0;
}

/* renderRow: cells left-justified to their column widths. */
static void scr_table_row(ScrTableBuf *b, ScrStr *const *cells, const size_t *widths, size_t n) {
  scr_tb_cstr(b, "\xe2\x94\x82 ");
  for (size_t i = 0; i < n; i++) {
    if (cells[i]) scr_tb_put(b, cells[i]->data, cells[i]->len);
    scr_tb_repeat(b, " ", widths[i] - scr_table_width(cells[i]));
    if (i + 1 != n) scr_tb_cstr(b, " \xe2\x94\x82 ");
  }
  scr_tb_cstr(b, " \xe2\x94\x82");
}

static void scr_table_divider(ScrTableBuf *b, const size_t *widths, size_t n, const char *left,
                              const char *middle, const char *right) {
  scr_tb_cstr(b, left);
  for (size_t i = 0; i < n; i++) {
    if (i) scr_tb_cstr(b, middle);
    scr_tb_repeat(b, "\xe2\x94\x80", widths[i] + 2);
  }
  scr_tb_cstr(b, right);
}

/* One rendered line to a Console's stdout (NULL: the global console). */
static void scr_console_emit(ScrConsoleInst *inst, ScrStr *text) {
  if (inst) scr_console_inst_print(inst, 0, text);
  else scr_console_print(text);
}

/* cli_table(head, columns) over n columns of `rows` cells, printed through
 * the console's log. */
static void scr_table_print(ScrConsoleInst *inst, ScrStr *const *head,
                            ScrStr *const *const *columns, size_t n, size_t rows) {
  size_t *widths = calloc(n ? n : 1, sizeof *widths);
  ScrStr **row = calloc(n ? n : 1, sizeof *row);
  if (!widths || !row) scr_trap("scriptc: out of memory\n");
  for (size_t i = 0; i < n; i++) {
    widths[i] = scr_table_width(head[i]);
    for (size_t j = 0; j < rows; j++) {
      size_t w = scr_table_width(columns[i][j]);
      if (w > widths[i]) widths[i] = w;
    }
  }
  ScrTableBuf b = {0};
  scr_table_divider(&b, widths, n, "\xe2\x94\x8c", "\xe2\x94\xac", "\xe2\x94\x90");
  scr_tb_cstr(&b, "\n");
  scr_table_row(&b, head, widths, n);
  scr_tb_cstr(&b, "\n");
  scr_table_divider(&b, widths, n, "\xe2\x94\x9c", "\xe2\x94\xbc", "\xe2\x94\xa4");
  scr_tb_cstr(&b, "\n");
  for (size_t j = 0; j < rows; j++) {
    for (size_t i = 0; i < n; i++) row[i] = columns[i][j];
    scr_table_row(&b, row, widths, n);
    scr_tb_cstr(&b, "\n");
  }
  scr_table_divider(&b, widths, n, "\xe2\x94\x94", "\xe2\x94\xb4", "\xe2\x94\x98");
  ScrStr *text = scr_str_new(b.data, b.len);
  free(b.data);
  free(widths);
  free(row);
  scr_console_emit(inst, text);
  scr_str_release(text);
}

static void scr_console_table_impl(ScrDyn *data_in, ScrDyn *properties, ScrConsoleInst *inst) {
  ScrDyn *data = scr_table_view(data_in);
  /* `tabularData === null || typeof tabularData !== 'object'`: log it. */
  if (data->kind != SCR_DYN_OBJ && data->kind != SCR_DYN_ARR && data->kind != SCR_DYN_BYTES) {
    if (data->kind == SCR_DYN_HANDLE || data->kind == SCR_DYN_PROMISE) {
      scr_table_fence("console.table of this value has no lowering");
    } else {
      ScrStr *text = scr_insp_dyn_s(data, 2);
      if (!scr_exc_pending()) scr_console_emit(inst, text);
      scr_str_release(text);
    }
    scr_dyn_release(data);
    return;
  }
  if (data->kind == SCR_DYN_OBJ && scr_dyn_obj_get(data, "%error", 6) != NULL) {
    scr_table_fence("console.table of an Error value has no lowering");
    scr_dyn_release(data);
    return;
  }
  ScrDyn *props = properties->kind == SCR_DYN_UNDEF ? NULL : scr_table_view(properties);
  if (props) {
    bool names = props->kind == SCR_DYN_ARR;
    for (size_t i = 0; names && i < props->v.arr.len; i++)
      names = props->v.arr.items[i]->kind == SCR_DYN_STR;
    if (!names) {
      scr_table_fence("console.table with a properties argument other than an array of strings has no lowering");
      scr_dyn_release(props);
      scr_dyn_release(data);
      return;
    }
  }
  size_t rows = 0;
  ScrStr **index = scr_table_own_keys(data, &rows);
  ScrTable t = {.rows = rows};
  ScrStr **values = calloc(rows ? rows : 1, sizeof *values);
  if (!values) scr_trap("scriptc: out of memory\n");
  bool has_primitives = false;
  for (size_t i = 0; i < rows && !scr_exc_pending(); i++) {
    ScrDyn *raw = scr_table_own_value(data, index[i]);
    if (!raw) break;
    ScrDyn *item = scr_table_view(raw);
    scr_dyn_release(raw);
    bool primitive = scr_table_primitive(item);
    if (!primitive && (item->kind == SCR_DYN_HANDLE || item->kind == SCR_DYN_PROMISE ||
                       (item->kind == SCR_DYN_FUNC && props) ||
                       (item->kind == SCR_DYN_OBJ && scr_dyn_obj_get(item, "%error", 6) != NULL))) {
      scr_table_fence("console.table rows of this kind have no lowering");
      scr_dyn_release(item);
      break;
    }
    if (!props && primitive) {
      has_primitives = true;
      values[i] = scr_insp_table_cell(item);
    } else if (props) {
      for (size_t k = 0; k < props->v.arr.len && !scr_exc_pending(); k++) {
        ScrStr *key = props->v.arr.items[k]->v.str;
        ScrTableColumn *col = scr_table_column(&t, key);
        ScrDyn *value = primitive ? NULL : scr_table_own_value(item, key);
        if (col->cells[i]) scr_str_release(col->cells[i]);
        col->cells[i] = value ? scr_insp_table_cell(value) : scr_str_new("", 0);
        if (value) scr_dyn_release(value);
      }
    } else {
      size_t nkeys = 0;
      ScrStr **keys = scr_table_own_keys(item, &nkeys);
      for (size_t k = 0; k < nkeys; k++) {
        if (!scr_exc_pending()) {
          ScrTableColumn *col = scr_table_column(&t, keys[k]);
          ScrDyn *value = scr_table_own_value(item, keys[k]);
          if (value) {
            if (col->cells[i]) scr_str_release(col->cells[i]);
            col->cells[i] = scr_insp_table_cell(value);
            scr_dyn_release(value);
          }
        }
        scr_str_release(keys[k]);
      }
      free(keys);
    }
    scr_dyn_release(item);
  }
  if (!scr_exc_pending()) {
    /* Object.keys(map): the property columns in key order, then Values. */
    size_t n = t.len;
    const char **names = calloc(n ? n : 1, sizeof *names);
    size_t *lens = calloc(n ? n : 1, sizeof *lens);
    size_t *order = calloc(n ? n : 1, sizeof *order);
    ScrStr **head = calloc(n + 2, sizeof *head);
    ScrStr ***columns = calloc(n + 2, sizeof *columns);
    if (!names || !lens || !order || !head || !columns) scr_trap("scriptc: out of memory\n");
    for (size_t i = 0; i < n; i++) {
      names[i] = t.cols[i].key->data;
      lens[i] = t.cols[i].key->len;
    }
    scr_table_key_order(names, lens, n, order);
    ScrStr *index_head = scr_str_new("(index)", 7);
    ScrStr *values_head = scr_str_new("Values", 6);
    size_t c = 0;
    head[c] = index_head;
    columns[c++] = index;
    for (size_t i = 0; i < n; i++) {
      head[c] = t.cols[order[i]].key;
      columns[c++] = t.cols[order[i]].cells;
    }
    if (has_primitives) {
      head[c] = values_head;
      columns[c++] = values;
    }
    scr_table_print(inst, head, (ScrStr *const *const *)columns, c, rows);
    scr_str_release(index_head);
    scr_str_release(values_head);
    free(names);
    free(lens);
    free(order);
    free(head);
    free(columns);
  }
  for (size_t i = 0; i < t.len; i++) scr_table_column_free(&t.cols[i], rows);
  free(t.cols);
  for (size_t i = 0; i < rows; i++) {
    if (index[i]) scr_str_release(index[i]);
    if (values[i]) scr_str_release(values[i]);
  }
  free(index);
  free(values);
  if (props) scr_dyn_release(props);
  scr_dyn_release(data);
}

void scr_console_table(ScrDyn *data_in, ScrDyn *properties) {
  scr_console_table_impl(data_in, properties, NULL);
}

void scr_console_inst_table(ScrDyn *console, ScrDyn *data_in, ScrDyn *properties) {
  ScrConsoleInst *inst = scr_console_inst_of(console, "console.table");
  if (!inst) return;
  scr_console_table_impl(data_in, properties, inst);
}
