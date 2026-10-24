#include "scr_runtime.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Stored console methods use the same native rendering as direct output.
 * Reflection, mutation, and further Console APIs remain explicit boundaries. */
static SCR_TL ScrDyn *scr_console_methods[5];
static SCR_TL bool scr_console_registered;
static void scr_console_methods_cleanup(void) {
  for (size_t i = 0; i < 5; i++) {
    ScrDyn *method = scr_console_methods[i];
    scr_console_methods[i] = NULL;
    scr_dyn_release(method);
  }
}

static ScrDyn *scr_console_method_call(ScrClosure *closure, ScrDyn *const *args, size_t argc) {
  if (argc > 1 && args[0]->kind == SCR_DYN_STR) {
    ScrStr *format = args[0]->v.str;
    for (size_t i = 0; i + 1 < format->len; i++) if (format->data[i] == '%' &&
        strchr("sdifjoOc%", format->data[i + 1])) {
      static const char message[] = "Format strings through stored console methods have no lowering";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
      return NULL;
    }
  }
  ScrLogArg *rendered = argc ? calloc(argc, sizeof *rendered) : NULL;
  if (argc && !rendered) scr_trap("scriptc: out of memory\n");
  size_t count = 0;
  for (; count < argc; count++) {
    rendered[count].tag = SCR_ARG_STR;
    rendered[count].v.s = scr_insp_dyn_s(args[count], 2);
    if (scr_exc_pending()) break;
  }
  if (!scr_exc_pending()) {
    if (scr_box_get_f64(closure->caps[0]) != 0) scr_console_error(argc, rendered);
    else scr_console_log(argc, rendered);
  }
  for (size_t i = 0; i < argc; i++) scr_str_release(rendered[i].v.s);
  free(rendered);
  return scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined());
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
  const char *names[] = {"log", "info", "debug", "error", "warn"};
  for (size_t i = 0; i < 5; i++) if (strlen(names[i]) == len && memcmp(names[i], key, len) == 0) {
    if (!scr_console_methods[i]) {
      ScrClosure *closure = scr_closure_new(NULL, 1);
      closure->caps[0] = scr_box_new(SCR_BOX_F64);
      scr_box_set_f64(closure->caps[0], i >= 3 ? 1 : 0);
      scr_console_methods[i] = scr_dyn_new_func(closure, scr_console_method_call, 0, "", names[i]);
    }
    return scr_dyn_retain(scr_console_methods[i]);
  }
  static const char *unsupported[] = {"Console", "assert", "clear", "count", "countReset", "dir", "dirxml", "group", "groupCollapsed", "groupEnd", "table", "time", "timeEnd", "timeLog", "trace", "profile", "profileEnd", "timeStamp", "context", "_stdout", "_stderr"};
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

static void scr_console_inst_release(void *ptr) {
  ScrConsoleInst *inst = ptr;
  if (--inst->rc) return;
  if (inst->stream_drop) inst->stream_drop(inst);
  free(inst);
}

/* text + "\n" to one target (Node's kWriteToConsole with no group
 * indentation): a bound stream receives ONE write; process stdio rides
 * the console output path. Borrows text. */
static void scr_console_inst_print(ScrConsoleInst *inst, int which, ScrStr *text) {
  if (inst->stream[which]) {
    ScrStr *nl = scr_str_new("\n", 1);
    ScrStr *line = scr_str_concat(text, nl);
    scr_str_release(nl);
    inst->stream_write(inst, which, line);
    scr_str_release(line);
    return;
  }
  ScrLogArg arg = {.tag = SCR_ARG_STR};
  arg.v.s = text;
  scr_console_write_fd(inst->fd[which] == 2 ? 2 : 1, 1, &arg);
}

/* 0 for the stdout members, 1 for the stderr members, -1 otherwise. */
static int scr_console_member_target(const char *key, size_t len) {
  const char *names[] = {"log", "info", "debug", "error", "warn"};
  for (int i = 0; i < 5; i++)
    if (strlen(names[i]) == len && memcmp(names[i], key, len) == 0) return i >= 3 ? 1 : 0;
  return -1;
}

/* Node binds each method to its instance (stable identity per instance);
 * reading one as a value stays an explicit boundary. */
static ScrDyn *scr_console_inst_get(void *ptr, const char *key, size_t len) {
  (void)ptr;
  if (scr_console_member_target(key, len) >= 0) {
    static const char message[] = "Stored Console instance methods have no lowering; call them on the instance";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
    return NULL;
  }
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

/* Dynamic calls render like the stored global methods: every argument
 * through the dyn inspector (strings verbatim), space-joined. */
static ScrDyn *scr_console_inst_invoke(void *ptr, ScrDyn *self, const char *key, ScrDyn *const *args,
                                       size_t argc, const char *what) {
  (void)self; (void)what;
  int which = scr_console_member_target(key, strlen(key));
  if (which < 0) return scr_console_inst_get(ptr, key, strlen(key));
  if (argc > 1 && args[0]->kind == SCR_DYN_STR) {
    ScrStr *format = args[0]->v.str;
    for (size_t i = 0; i + 1 < format->len; i++) if (format->data[i] == '%' &&
        strchr("sdifjoOc%", format->data[i + 1])) {
      static const char message[] = "Format strings through dynamic Console calls have no lowering";
      scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
      return NULL;
    }
  }
  ScrStr **parts = calloc(argc ? 2 * argc : 1, sizeof *parts);
  if (!parts) scr_trap("scriptc: out of memory\n");
  ScrStr *space = scr_str_new(" ", 1);
  size_t n = 0;
  for (size_t i = 0; i < argc; i++) {
    ScrStr *rendered = scr_insp_dyn_s(args[i], 2);
    if (scr_exc_pending()) {
      scr_str_release(rendered);
      break;
    }
    if (i) parts[n++] = space;
    parts[n++] = rendered;
  }
  if (!scr_exc_pending()) {
    ScrStr *text = scr_str_concat_parts(parts, n);
    scr_console_inst_print(ptr, which, text);
    scr_str_release(text);
  }
  for (size_t i = 0; i < n; i++) if (parts[i] != space) scr_str_release(parts[i]);
  scr_str_release(space);
  free(parts);
  return scr_exc_pending() ? NULL : scr_dyn_retain(scr_dyn_undefined());
}

ScrDyn *scr_console_new(double out_fd, double err_fd, bool ignore_errors) {
  static const ScrDynHandleOps ops = {"console", scr_console_inst_retain, scr_console_inst_release,
                                      scr_console_inst_invoke, scr_console_inst_get,
                                      scr_console_inst_set, NULL, NULL};
  scr_dyn_handle_install(SCR_DYNH_CONSOLE_INSTANCE, &ops);
  ScrConsoleInst *inst = calloc(1, sizeof *inst);
  if (!inst) scr_trap("scriptc: out of memory\n");
  inst->rc = 1;
  inst->fd[0] = out_fd;
  inst->fd[1] = err_fd;
  inst->ignore_errors = ignore_errors;
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

/* ── the global console's counters, timers, groups, and table ─────────
 * Node keeps these per Console instance; the lowered surface is the global
 * console's, so each is one per-thread store (workers own their console).
 * Labels are compared by their string form; the stores are tiny linear
 * tables, as a program holds a handful of labels at a time. */

typedef struct {
  ScrStr *label;
  double count;     /* counters */
  uint64_t started; /* timers: scr_hrtime_ns at console.time */
} ScrConsoleSlot;

typedef struct {
  ScrConsoleSlot *slots;
  size_t len, cap;
} ScrConsoleStore;

static SCR_TL ScrConsoleStore scr_console_counts, scr_console_timers;
static SCR_TL bool scr_console_stores_registered;

static void scr_console_store_clear(ScrConsoleStore *store) {
  for (size_t i = 0; i < store->len; i++) scr_str_release(store->slots[i].label);
  free(store->slots);
  store->slots = NULL;
  store->len = store->cap = 0;
}

static void scr_console_stores_cleanup(void) {
  scr_console_store_clear(&scr_console_counts);
  scr_console_store_clear(&scr_console_timers);
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

/* console.count: "label: n". */
void scr_console_count(ScrStr *label) {
  ScrConsoleSlot *slot = scr_console_find(&scr_console_counts, label);
  if (!slot) slot = scr_console_add(&scr_console_counts, label);
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
ScrStr *scr_console_count_reset(ScrDyn *label) {
  ScrStr *text = scr_console_label(label);
  if (scr_exc_pending()) return text;
  bool keyed = label->kind == SCR_DYN_UNDEF || label->kind == SCR_DYN_STR;
  ScrConsoleSlot *slot = keyed ? scr_console_find(&scr_console_counts, text) : NULL;
  if (slot) {
    scr_console_remove(&scr_console_counts, slot);
    scr_str_release(text);
    return scr_str_new("", 0);
  }
  ScrStr *message = scr_console_message("Count for '", text, "' does not exist");
  scr_str_release(text);
  return message;
}

ScrStr *scr_console_time(ScrStr *label) {
  if (scr_console_find(&scr_console_timers, label))
    return scr_console_message("Label '", label, "' already exists for console.time()");
  scr_console_add(&scr_console_timers, label)->started = scr_hrtime_ns();
  return scr_str_new("", 0);
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

static ScrStr *scr_console_elapsed(ScrStr *label, bool end) {
  ScrConsoleSlot *slot = scr_console_find(&scr_console_timers, label);
  if (!slot) return scr_str_new("", 0);
  /* process.hrtime(start): [seconds, nanoseconds], then
   * seconds * 1000 + nanoseconds / 1e6. */
  uint64_t elapsed = scr_hrtime_ns() - slot->started;
  double ms = (double)(elapsed / 1000000000u) * 1000 + (double)(elapsed % 1000000000u) / 1e6;
  if (end) scr_console_remove(&scr_console_timers, slot);
  return scr_console_format_time(ms);
}

ScrStr *scr_console_time_end(ScrStr *label) { return scr_console_elapsed(label, true); }

ScrStr *scr_console_time_log(ScrStr *label) { return scr_console_elapsed(label, false); }

/* Node's kGroupIndentationString: two spaces per open group. */
static SCR_TL size_t scr_console_group_indent = 0;

/* kWriteToConsole's indentation: the indent before the line and after
 * every newline inside it (the trailing newline excluded). */
static char *scr_console_indent_line(const char *line, size_t *used) {
  size_t indent = scr_console_group_indent;
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

void scr_console_group(double delta) {
  if (delta > 0) scr_console_group_indent += 2;
  else if (scr_console_group_indent >= 2) scr_console_group_indent -= 2;
  scr_console_indenter = scr_console_group_indent ? scr_console_indent_line : NULL;
}

/* Only a terminal stdout clears (TERM=dumb excepted): readline's
 * cursorTo(stdout, 0, 0), then clearScreenDown(stdout). */
void scr_console_clear(void) {
  if (!scr_process_is_tty(1)) return;
  const char *term = getenv("TERM");
  if (term && strcmp(term, "dumb") == 0) return;
  scr_stdio_write(1, "\x1b[1;1H", 6);
  scr_stdio_write(1, "\x1b[0J", 4);
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
      for (size_t i = 0; i < d->v.obj.len; i++) {
        const ScrDyn *value = d->v.obj.entries[i].value;
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
  size_t len = item->v.obj.len;
  const char **names = calloc(len ? len : 1, sizeof *names);
  size_t *lens = calloc(len ? len : 1, sizeof *lens);
  size_t *order = calloc(len ? len : 1, sizeof *order);
  ScrStr **keys = calloc(len ? len : 1, sizeof *keys);
  if (!names || !lens || !order || !keys) scr_trap("scriptc: out of memory\n");
  size_t n = 0;
  for (size_t i = 0; i < len; i++) {
    const ScrDynEntry *ent = &item->v.obj.entries[i];
    if (!ent->enumerable) continue;
    names[n] = ent->key;
    lens[n] = ent->key_len;
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
    for (size_t i = 0; i < item->v.obj.len; i++) {
      const ScrDynEntry *ent = &item->v.obj.entries[i];
      if (ent->key_len != key->len || memcmp(ent->key, key->data, key->len) != 0) continue;
      if (ent->accessor) {
        scr_table_fence("console.table rows with accessor properties have no lowering");
        return NULL;
      }
      return scr_dyn_retain(ent->value);
    }
    return NULL;
  }
  if (item->kind == SCR_DYN_ARR || item->kind == SCR_DYN_BYTES) {
    size_t len = item->kind == SCR_DYN_ARR ? item->v.arr.len : item->v.bytes->len;
    if (key->len == 6 && memcmp(key->data, "length", 6) == 0) return scr_dyn_new_num((double)len);
    uint32_t index;
    if (!scr_table_index_key(key->data, key->len, &index) || index >= len) return NULL;
    if (item->kind == SCR_DYN_ARR) return scr_dyn_retain(item->v.arr.items[index]);
    return scr_dyn_new_num(scr_bytes_get(item->v.bytes, (double)index));
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

/* cli_table(head, columns) over n columns of `rows` cells, printed through
 * the global console's log. */
static void scr_table_print(ScrStr *const *head, ScrStr *const *const *columns, size_t n, size_t rows) {
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
  scr_console_print(text);
  scr_str_release(text);
}

void scr_console_table(ScrDyn *data_in, ScrDyn *properties) {
  ScrDyn *data = scr_table_view(data_in);
  /* `tabularData === null || typeof tabularData !== 'object'`: log it. */
  if (data->kind != SCR_DYN_OBJ && data->kind != SCR_DYN_ARR && data->kind != SCR_DYN_BYTES) {
    if (data->kind == SCR_DYN_HANDLE || data->kind == SCR_DYN_PROMISE) {
      scr_table_fence("console.table of this value has no lowering");
    } else {
      ScrStr *text = scr_insp_dyn_s(data, 2);
      if (!scr_exc_pending()) scr_console_print(text);
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
    scr_table_print(head, (ScrStr *const *const *)columns, c, rows);
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
