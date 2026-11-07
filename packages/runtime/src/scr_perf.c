/* node:perf_hooks user timing: performance.mark / measure, the global
 * performance timeline (getEntries / getEntriesByName / getEntriesByType)
 * and clearMarks / clearMeasures — lib/internal/perf/usertiming.js and
 * observe.js's buffers, per thread like Node's per-isolate state.
 *
 * Arguments arrive as one dyn argument vector so Node's validation runs
 * here in its own order. Each producing call leaves its answer in the
 * thread's VIEW (one entry for mark/measure, the filtered and sorted list
 * for the getters). The compiler builds the record for a new entry from
 * the view through the field accessors and hands it back to keep in the
 * buffer; the getters answer those kept records, so entries keep their
 * identity like Node's. */

#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  ScrStr *name;   /* owned */
  ScrDyn *detail; /* owned; the dyn null when the call had none */
  ScrDyn *ref;    /* owned: the program's entry object, once kept */
  double start;
  double duration;
  bool measure;
} ScrPerfEntry;

typedef struct {
  ScrPerfEntry *items;
  size_t len;
  size_t cap;
  bool warned; /* the MaxPerformanceEntryBufferExceededWarning went out */
} ScrPerfBuffer;

static SCR_TL ScrPerfBuffer scr_perf_marks;
static SCR_TL ScrPerfBuffer scr_perf_measures;
/* The buffer the last mark or measure went into (its entry is last). */
static SCR_TL ScrPerfBuffer *scr_perf_last;
/* The last answer: borrowed copies of buffered entries, valid until the
 * next timeline call. */
static SCR_TL ScrPerfEntry *scr_perf_view;
static SCR_TL size_t scr_perf_view_len;
static SCR_TL size_t scr_perf_view_cap;
/* usertiming.js's markTimings: the latest time each mark name was set,
 * kept apart from the buffer (clearMarks clears both; a mark whose
 * detail fails to clone still records its time, like Node). */
static SCR_TL ScrMap *scr_perf_timings;
static SCR_TL bool scr_perf_cleanup_armed;

/* Node warns once per entry type past this many buffered entries. */
#define SCR_PERF_WARN_SIZE 1000000

static void scr_perf_buffer_clear(ScrPerfBuffer *b) {
  for (size_t i = 0; i < b->len; i++) {
    scr_str_release(b->items[i].name);
    scr_dyn_release(b->items[i].detail);
    scr_dyn_release(b->items[i].ref);
  }
  b->len = 0;
}

static void scr_perf_cleanup(void) {
  scr_perf_buffer_clear(&scr_perf_marks);
  scr_perf_buffer_clear(&scr_perf_measures);
  free(scr_perf_marks.items);
  free(scr_perf_measures.items);
  free(scr_perf_view);
  scr_map_release(scr_perf_timings);
  scr_perf_marks = (ScrPerfBuffer){0};
  scr_perf_measures = (ScrPerfBuffer){0};
  scr_perf_view = NULL;
  scr_perf_view_len = scr_perf_view_cap = 0;
  scr_perf_timings = NULL;
  scr_perf_last = NULL;
  scr_perf_cleanup_armed = false;
}

static void scr_perf_arm(void) {
  if (scr_perf_cleanup_armed) return;
  scr_perf_cleanup_armed = true;
  scr_atexit(scr_perf_cleanup);
}

static ScrMap *scr_perf_timing_map(void) {
  if (!scr_perf_timings) scr_perf_timings = scr_map_new(SCR_MAP_KEY_STR, SCR_MAP_VAL_F64, NULL);
  return scr_perf_timings;
}

static void scr_perf_view_reserve(size_t n) {
  if (n <= scr_perf_view_cap) return;
  size_t cap = scr_perf_view_cap ? scr_perf_view_cap : 8;
  while (cap < n) cap *= 2;
  ScrPerfEntry *items = realloc(scr_perf_view, cap * sizeof *items);
  if (!items) scr_trap("scriptc: out of memory\n");
  scr_perf_view = items;
  scr_perf_view_cap = cap;
}

static void scr_perf_push(ScrPerfBuffer *b, ScrPerfEntry entry) {
  if (b->len == b->cap) {
    size_t cap = b->cap ? b->cap * 2 : 16;
    ScrPerfEntry *items = realloc(b->items, cap * sizeof *items);
    if (!items) scr_trap("scriptc: out of memory\n");
    b->items = items;
    b->cap = cap;
  }
  b->items[b->len++] = entry;
  scr_perf_last = b;
  scr_perf_view_reserve(1);
  scr_perf_view[0] = entry;
  scr_perf_view_len = 1;
  if (b->len > SCR_PERF_WARN_SIZE && !b->warned) {
    b->warned = true;
    const char *type = entry.measure ? "measure" : "mark";
    char msg[256];
    int n = snprintf(msg, sizeof msg,
                     "Possible perf_hooks memory leak detected. %zu %s entries added to the global "
                     "performance entry buffer. Use performance.%s to clear the buffer.",
                     b->len, type, entry.measure ? "clearMeasures" : "clearMarks");
    ScrStr *text = scr_str_new(msg, (size_t)n);
    scr_emit_warning("MaxPerformanceEntryBufferExceededWarning", NULL, text);
    scr_str_release(text);
  }
}

/* The entry points take their arguments as one dyn array. Anything else
 * throws a TypeError before the vector is read. */
static bool scr_perf_args_ok(const ScrDyn *args, const char *what) {
  if (args && args->kind == SCR_DYN_ARR) return true;
  char message[96];
  snprintf(message, sizeof message, "performance.%s received a non-array argument list", what);
  scr_throw_error_msg(SCR_ERR_TYPE, message, strlen(message));
  return false;
}

/* Argument i of a vector that passed scr_perf_args_ok. */
static ScrDyn *scr_perf_arg(const ScrDyn *args, size_t i) {
  return i < args->v.arr.len ? args->v.arr.items[i] : scr_dyn_undefined();
}

static bool scr_perf_nullish(const ScrDyn *v) {
  return v->kind == SCR_DYN_UNDEF || v->kind == SCR_DYN_NULL;
}

/* The template-literal ToString Node applies to names and types; NULL
 * with the exception pending (a Symbol). */
static ScrStr *scr_perf_string(const ScrDyn *v) { return scr_dyn_string_coerce_js(v); }

/* `value.key` on an object value (+1; NULL with the exception pending).
 * Native objects without such members read undefined. */
static ScrDyn *scr_perf_member(ScrDyn *object, const char *key) {
  if (object->kind != SCR_DYN_OBJ && object->kind != SCR_DYN_ARR &&
      object->kind != SCR_DYN_TYPED_REF && object->kind != SCR_DYN_PROXY)
    return scr_dyn_undefined();
  ScrStr *name = scr_str_new(key, strlen(key));
  ScrDyn *boxed = scr_dyn_new_str(name);
  scr_str_release(name);
  ScrDyn *out = scr_dyn_reflect_get(object, boxed, object);
  scr_dyn_release(boxed);
  return out;
}

static void scr_perf_missing(const char *name) {
  char msg[96];
  int n = snprintf(msg, sizeof msg, "The \"%s\" argument must be specified", name);
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)n, "ERR_MISSING_ARGS");
}

static void scr_perf_invalid_timestamp(double t) {
  char num[40];
  size_t len = scr_f64_to_str(t, num);
  char msg[96];
  int n = snprintf(msg, sizeof msg, "%.*s is not a valid timestamp", (int)len, num);
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)n, "ERR_PERFORMANCE_INVALID_TIMESTAMP");
}

static void scr_perf_invalid_options(const char *message) {
  scr_throw_error_msg_code(SCR_ERR_TYPE, message, strlen(message),
                           "ERR_PERFORMANCE_MEASURE_INVALID_OPTIONS");
}

/* nodeTimingReadOnlyAttributes: names that read performance.nodeTiming
 * instead of a mark, and that marks may not take. */
static bool scr_perf_node_timing_name(const ScrStr *name) {
  static const char *const names[] = {"nodeStart", "v8Start", "environment",
                                      "loopStart", "loopExit", "bootstrapComplete"};
  for (size_t i = 0; i < sizeof names / sizeof names[0]; i++) {
    if (name->len == strlen(names[i]) && memcmp(name->data, names[i], name->len) == 0) return true;
  }
  return false;
}

static void scr_perf_reserved_name(ScrStr *name) {
  ScrDyn *got = scr_dyn_new_str(name);
  scr_dyn_arg_value_fail("name", NULL, got);
  scr_dyn_release(got);
}

/* structuredClone(detail) for a present detail, null otherwise. +1, or
 * NULL with the DataCloneError pending. */
static ScrDyn *scr_perf_detail(const ScrDyn *detail) {
  if (detail == NULL || scr_perf_nullish(detail)) return scr_dyn_new_null();
  return scr_structured_clone(detail, NULL);
}

/* usertiming.js getMark for a defined value: numbers are timestamps
 * (negative ones throw), anything else names a mark. */
static bool scr_perf_get_mark(const ScrDyn *value, double *out) {
  if (value->kind == SCR_DYN_NUM) {
    if (value->v.num < 0) {
      scr_perf_invalid_timestamp(value->v.num);
      return false;
    }
    *out = value->v.num;
    return true;
  }
  ScrStr *name = scr_perf_string(value);
  if (!name) return false;
  bool ok = false;
  if (scr_perf_node_timing_name(name)) {
    /* performance.nodeTiming's milestones describe Node's own startup,
     * which a compiled program does not have. */
    char msg[160];
    int n = snprintf(msg, sizeof msg,
                     "performance.measure with the '%.*s' Node timing milestone is not supported yet",
                     (int)name->len, name->data);
    scr_throw_error_msg_code(SCR_ERR_ERROR, msg, (size_t)n, "SC2020");
  } else if (scr_perf_timings && scr_map_get_str_f64(scr_perf_timings, name, out)) {
    ok = true;
  } else {
    ScrStr *head = scr_str_new("The \"", 5);
    ScrStr *tail = scr_str_new("\" performance mark has not been set", 35);
    ScrStr *quoted = scr_str_concat(head, name);
    ScrStr *message = scr_str_concat(quoted, tail);
    scr_str_release(head);
    scr_str_release(tail);
    scr_str_release(quoted);
    scr_throw_domex_str("SyntaxError", message);
  }
  scr_str_release(name);
  return ok;
}

double scr_perf_mark(ScrDyn *args) {
  if (!scr_perf_args_ok(args, "mark")) return 0;
  if (args->v.arr.len == 0) {
    scr_perf_missing("name");
    return 0;
  }
  ScrStr *name = scr_perf_string(scr_perf_arg(args, 0));
  if (!name) return 0;
  if (scr_perf_node_timing_name(name)) {
    scr_perf_reserved_name(name);
    scr_str_release(name);
    return 0;
  }
  ScrDyn *options = scr_perf_arg(args, 1);
  bool has_options = !scr_perf_nullish(options);
  if (has_options && (options->kind == SCR_DYN_ARR || !scr_dyn_is_object(options))) {
    scr_dyn_arg_type_fail("options", "of type object", options);
    scr_str_release(name);
    return 0;
  }
  ScrDyn *start = has_options ? scr_perf_member(options, "startTime") : NULL;
  if (has_options && !start) {
    scr_str_release(name);
    return 0;
  }
  double t;
  if (start == NULL || scr_perf_nullish(start)) {
    t = scr_perf_now();
  } else if (start->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail("startTime", "of type number", start);
    scr_dyn_release(start);
    scr_str_release(name);
    return 0;
  } else {
    t = start->v.num;
  }
  scr_dyn_release(start);
  if (t < 0) {
    scr_perf_invalid_timestamp(t);
    scr_str_release(name);
    return 0;
  }
  scr_perf_arm();
  scr_map_set_str_f64(scr_perf_timing_map(), name, t);
  ScrDyn *detail = has_options ? scr_perf_member(options, "detail") : NULL;
  ScrDyn *cloned = has_options && !detail ? NULL : scr_perf_detail(detail);
  if (detail) scr_dyn_release(detail);
  if (!cloned) {
    scr_str_release(name);
    return 0;
  }
  scr_perf_push(&scr_perf_marks, (ScrPerfEntry){name, cloned, NULL, t, 0, false});
  return 1;
}

double scr_perf_measure(ScrDyn *args) {
  if (!scr_perf_args_ok(args, "measure")) return 0;
  if (args->v.arr.len == 0) {
    scr_perf_missing("name");
    return 0;
  }
  ScrDyn *name_arg = scr_perf_arg(args, 0);
  if (name_arg->kind != SCR_DYN_STR) {
    scr_dyn_arg_type_fail("name", "of type string", name_arg);
    return 0;
  }
  /* The startOrMeasureOptions default (an empty object) and its `??= 0`. */
  ScrDyn *so = scr_perf_arg(args, 1);
  bool so_object = so->kind == SCR_DYN_UNDEF || (so->kind != SCR_DYN_NULL && scr_dyn_is_object(so));
  ScrDyn *end_mark = scr_perf_arg(args, 2);
  bool has_end_mark = end_mark->kind != SCR_DYN_UNDEF;
  ScrDyn *o_start = NULL, *o_end = NULL, *o_duration = NULL, *o_detail = NULL;
  bool ok = true;
  if (so_object && so->kind != SCR_DYN_UNDEF) {
    o_start = scr_perf_member(so, "start");
    ok = o_start != NULL;
    if (ok) ok = (o_end = scr_perf_member(so, "end")) != NULL;
    if (ok) ok = (o_duration = scr_perf_member(so, "duration")) != NULL;
  }
  bool has_start = o_start && o_start->kind != SCR_DYN_UNDEF;
  bool has_end = o_end && o_end->kind != SCR_DYN_UNDEF;
  bool has_duration = o_duration && o_duration->kind != SCR_DYN_UNDEF;
  bool options_valid = has_start || has_end;
  if (ok && options_valid) {
    if (has_end_mark) {
      scr_perf_invalid_options("endMark must not be specified");
      ok = false;
    } else if (has_start && has_end && has_duration) {
      scr_perf_invalid_options("Must not have options.start, options.end, and options.duration specified");
      ok = false;
    }
  }
  double start = 0, end = 0, duration = 0;
  if (ok) {
    if (has_end_mark) {
      ok = scr_perf_get_mark(end_mark, &end);
    } else if (options_valid && has_end) {
      ok = scr_perf_get_mark(o_end, &end);
    } else if (options_valid && has_start && has_duration) {
      double a = 0, b = 0;
      ok = scr_perf_get_mark(o_start, &a) && scr_perf_get_mark(o_duration, &b);
      end = a + b;
    } else {
      end = scr_perf_now();
    }
  }
  if (ok) {
    if (so->kind == SCR_DYN_STR) {
      ok = scr_perf_get_mark(so, &start);
    } else if (options_valid && has_start) {
      ok = scr_perf_get_mark(o_start, &start);
    } else if (options_valid && has_duration) {
      double d = 0;
      ok = scr_perf_get_mark(o_duration, &d);
      start = end - d;
    } else {
      start = 0;
    }
  }
  duration = end - start;
  /* `startOrMeasureOptions?.detail`: strings and numbers have none. */
  if (ok && so_object && so->kind != SCR_DYN_UNDEF) ok = (o_detail = scr_perf_member(so, "detail")) != NULL;
  scr_dyn_release(o_start);
  scr_dyn_release(o_end);
  scr_dyn_release(o_duration);
  ScrDyn *cloned = ok ? scr_perf_detail(o_detail) : NULL;
  scr_dyn_release(o_detail);
  if (!cloned) return 0;
  scr_perf_arm();
  ScrStr *name = scr_str_retain(name_arg->v.str);
  scr_perf_push(&scr_perf_measures, (ScrPerfEntry){name, cloned, NULL, start, duration, true});
  return 1;
}

/* Stable merge by startTime (observe.js sorts with a startTime
 * difference; ties keep buffer order). */
static void scr_perf_sort(ScrPerfEntry *items, size_t n) {
  if (n < 2) return;
  ScrPerfEntry *tmp = malloc(n * sizeof *tmp);
  if (!tmp) scr_trap("scriptc: out of memory\n");
  for (size_t width = 1; width < n; width *= 2) {
    for (size_t lo = 0; lo < n; lo += 2 * width) {
      size_t mid = lo + width < n ? lo + width : n;
      size_t hi = lo + 2 * width < n ? lo + 2 * width : n;
      size_t i = lo, j = mid, k = lo;
      while (i < mid && j < hi) {
        if (items[j].start - items[i].start < 0) tmp[k++] = items[j++];
        else tmp[k++] = items[i++];
      }
      while (i < mid) tmp[k++] = items[i++];
      while (j < hi) tmp[k++] = items[j++];
    }
    memcpy(items, tmp, n * sizeof *items);
  }
  free(tmp);
}

static void scr_perf_view_add(const ScrPerfBuffer *b, const ScrStr *name) {
  for (size_t i = 0; i < b->len; i++) {
    if (name && !scr_str_eq((ScrStr *)b->items[i].name, (ScrStr *)name)) continue;
    scr_perf_view_reserve(scr_perf_view_len + 1);
    scr_perf_view[scr_perf_view_len++] = b->items[i];
  }
}

/* which: 0 getEntries(), 1 getEntriesByName(name[, type]),
 * 2 getEntriesByType(type). Answers the entry count. */
double scr_perf_entries(ScrDyn *args, double which) {
  if (!scr_perf_args_ok(args, which == 0   ? "getEntries"
                              : which == 1 ? "getEntriesByName"
                                           : "getEntriesByType")) {
    return 0;
  }
  ScrStr *name = NULL, *type = NULL;
  if (which == 1) {
    if (args->v.arr.len == 0) {
      scr_perf_missing("name");
      return 0;
    }
    if (!(name = scr_perf_string(scr_perf_arg(args, 0)))) return 0;
    ScrDyn *t = scr_perf_arg(args, 1);
    if (t->kind != SCR_DYN_UNDEF && !(type = scr_perf_string(t))) {
      scr_str_release(name);
      return 0;
    }
  } else if (which == 2) {
    if (args->v.arr.len == 0) {
      scr_perf_missing("type");
      return 0;
    }
    if (!(type = scr_perf_string(scr_perf_arg(args, 0)))) return 0;
  }
  scr_perf_view_len = 0;
  bool marks = true, measures = true;
  if (type) {
    marks = type->len == 4 && memcmp(type->data, "mark", 4) == 0;
    measures = type->len == 7 && memcmp(type->data, "measure", 7) == 0;
  }
  if (marks) scr_perf_view_add(&scr_perf_marks, name);
  if (measures) scr_perf_view_add(&scr_perf_measures, name);
  scr_perf_sort(scr_perf_view, scr_perf_view_len);
  scr_str_release(name);
  scr_str_release(type);
  return (double)scr_perf_view_len;
}

static void scr_perf_buffer_drop(ScrPerfBuffer *b, const ScrStr *name) {
  if (!name) {
    scr_perf_buffer_clear(b);
    return;
  }
  size_t kept = 0;
  for (size_t i = 0; i < b->len; i++) {
    ScrPerfEntry e = b->items[i];
    if (scr_str_eq(e.name, (ScrStr *)name)) {
      scr_str_release(e.name);
      scr_dyn_release(e.detail);
      scr_dyn_release(e.ref);
    } else {
      b->items[kept++] = e;
    }
  }
  b->len = kept;
}

/* clearMarks([name]) / clearMeasures([name]). */
static void scr_perf_clear(ScrDyn *args, bool measures) {
  if (!scr_perf_args_ok(args, measures ? "clearMeasures" : "clearMarks")) return;
  scr_perf_view_len = 0;
  scr_perf_last = NULL;
  ScrDyn *arg = scr_perf_arg(args, 0);
  ScrStr *name = NULL;
  if (arg->kind != SCR_DYN_UNDEF && !(name = scr_perf_string(arg))) return;
  if (measures) {
    scr_perf_buffer_drop(&scr_perf_measures, name);
  } else {
    if (name && scr_perf_node_timing_name(name)) {
      scr_perf_reserved_name(name);
      scr_str_release(name);
      return;
    }
    if (scr_perf_timings) {
      if (name) scr_map_delete_str(scr_perf_timings, name);
      else scr_map_clear(scr_perf_timings);
    }
    scr_perf_buffer_drop(&scr_perf_marks, name);
  }
  scr_str_release(name);
}

void scr_perf_clear_marks(ScrDyn *args) { scr_perf_clear(args, false); }

void scr_perf_clear_measures(ScrDyn *args) { scr_perf_clear(args, true); }

static const ScrPerfEntry *scr_perf_at(double i) {
  size_t k = (size_t)i;
  if (i < 0 || k >= scr_perf_view_len) scr_trap("scriptc: performance entry read out of range\n");
  return &scr_perf_view[k];
}

ScrStr *scr_perf_entry_name(double i) { return scr_str_retain(scr_perf_at(i)->name); }

ScrStr *scr_perf_entry_type(double i) {
  return scr_perf_at(i)->measure ? scr_str_new("measure", 7) : scr_str_new("mark", 4);
}

double scr_perf_entry_start(double i) { return scr_perf_at(i)->start; }

double scr_perf_entry_duration(double i) { return scr_perf_at(i)->duration; }

ScrDyn *scr_perf_entry_detail(double i) { return scr_dyn_retain(scr_perf_at(i)->detail); }

/* The program keeps the object it built for the last mark or measure in
 * that entry (borrowed, retained here), so the getters answer the same
 * objects. */
void scr_perf_entry_keep(ScrDyn *ref) {
  if (!scr_perf_last || scr_perf_last->len == 0) return;
  ScrPerfEntry *e = &scr_perf_last->items[scr_perf_last->len - 1];
  scr_dyn_release(e->ref);
  e->ref = scr_dyn_retain(ref);
  scr_perf_last = NULL;
}

ScrDyn *scr_perf_entry_ref(double i) {
  ScrDyn *ref = scr_perf_at(i)->ref;
  if (!ref) scr_trap("scriptc: performance entry read before it was kept\n");
  return scr_dyn_retain(ref);
}
