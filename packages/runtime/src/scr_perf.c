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
  /* The producing call's serial: buffers and observer copies of the same
   * mark or measure share it, so the compiler's entryKeep finds them. */
  size_t id;
} ScrPerfEntry;

typedef struct {
  ScrPerfEntry *items; /* owned */
  size_t len;
  size_t cap;
} ScrPerfEntries;

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
/* The serial the next produced entry takes (see ScrPerfEntry.id). */
static SCR_TL size_t scr_perf_next_id;
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
/* new PerformanceMark's entry: owned here, borrowed by the view. */
static SCR_TL ScrPerfEntry scr_perf_scratch;
static SCR_TL bool scr_perf_scratch_set;
/* takeRecords' entries: owned here, borrowed by the view until the next
 * timeline call, like the scratch entry. */
static SCR_TL ScrPerfEntries scr_perf_taken;
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

static void scr_perf_scratch_clear(void) {
  if (!scr_perf_scratch_set) return;
  scr_str_release(scr_perf_scratch.name);
  scr_dyn_release(scr_perf_scratch.detail);
  scr_perf_scratch = (ScrPerfEntry){0};
  scr_perf_scratch_set = false;
}

static void scr_perf_observers_cleanup(void);
static void scr_perf_entries_clear(ScrPerfEntries *l);
static void scr_perf_observers_adopt_kept(size_t id, ScrDyn *ref);

static void scr_perf_cleanup(void) {
  scr_perf_observers_cleanup();
  scr_perf_scratch_clear();
  scr_perf_entries_clear(&scr_perf_taken);
  free(scr_perf_taken.items);
  scr_perf_taken = (ScrPerfEntries){0};
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

static void scr_perf_observers_enqueue(const ScrPerfEntry *entry);

static void scr_perf_push(ScrPerfBuffer *b, ScrPerfEntry entry) {
  /* The serial exists before any observer copy is made. */
  entry.id = ++scr_perf_next_id;
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
  /* observe.js's enqueue: the observers watching this type buffer it. */
  scr_perf_observers_enqueue(&b->items[b->len - 1]);
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

/* performance.nodeTiming's milestone values, as performance.measure reads
 * them: the startup milestones a compiled program does not have are 0, and
 * the loop's start and end are -1 until their moment (like Node). */
static double scr_perf_node_timing_value(const ScrStr *name) {
  if (name->len == 9 && memcmp(name->data, "loopStart", 9) == 0) return scr_perf_node_loop_start();
  if (name->len == 8 && memcmp(name->data, "loopExit", 8) == 0) return scr_perf_loop_exit();
  return 0;
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
    /* A Node timing milestone (usertiming.js getMark): its value, which
     * measure subtracts like any mark. */
    *out = scr_perf_node_timing_value(name);
    ok = true;
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

/* performance.mark (which buffers the entry and queues it for observers,
 * as usertiming.js's mark does) and new PerformanceMark (which only
 * records the mark timing): the same validation, in Node's order. The
 * unbuffered entry stays readable through the view for the record the
 * compiler builds from it. */
static double scr_perf_mark_impl(ScrDyn *args, bool buffer) {
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
  ScrPerfEntry entry = {name, cloned, NULL, t, 0, false, 0};
  if (buffer) {
    scr_perf_push(&scr_perf_marks, entry);
  } else {
    /* The view borrows the scratch entry, which owns the name and detail
     * until the next constructor call or exit. */
    scr_perf_scratch_clear();
    scr_perf_scratch = entry;
    scr_perf_scratch_set = true;
    scr_perf_view_reserve(1);
    scr_perf_view[0] = entry;
    scr_perf_view_len = 1;
    scr_perf_last = NULL;
  }
  return 1;
}

double scr_perf_mark(ScrDyn *args) { return scr_perf_mark_impl(args, true); }

double scr_perf_mark_new(ScrDyn *args) { return scr_perf_mark_impl(args, false); }

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
  scr_perf_push(&scr_perf_measures, (ScrPerfEntry){name, cloned, NULL, start, duration, true, 0});
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
  /* The observers watching the type buffered copies of this entry before
   * the program's object existed; each copy answers that same object, as
   * Node's entry list does. */
  scr_perf_observers_adopt_kept(e->id, ref);
  scr_perf_last = NULL;
}

ScrDyn *scr_perf_entry_ref(double i) {
  ScrDyn *ref = scr_perf_at(i)->ref;
  if (!ref) scr_trap("scriptc: performance entry read before it was kept\n");
  return scr_dyn_retain(ref);
}

/* ── PerformanceObserver and PerformanceObserverEntryList ─────────────
 * observe.js as the runtime sees it: observers watch entry types, buffer
 * the entries enqueue hands them, and the first buffered entry schedules
 * one immediate that dispatches every pending observer's callback with a
 * PerformanceObserverEntryList. Both objects are native handles, so a
 * program holds them as values, the callback's `observer` is the same
 * object as the constructed one, and instanceof asks the tag. */

static void scr_perf_entries_clear(ScrPerfEntries *l) {
  for (size_t i = 0; i < l->len; i++) {
    scr_str_release(l->items[i].name);
    scr_dyn_release(l->items[i].detail);
    scr_dyn_release(l->items[i].ref);
  }
  l->len = 0;
}

static void scr_perf_entries_push(ScrPerfEntries *l, ScrPerfEntry entry) {
  if (l->len == l->cap) {
    size_t cap = l->cap ? l->cap * 2 : 8;
    ScrPerfEntry *items = realloc(l->items, cap * sizeof *items);
    if (!items) scr_trap("scriptc: out of memory\n");
    l->items = items;
    l->cap = cap;
  }
  l->items[l->len++] = entry;
}

static ScrPerfEntry scr_perf_entry_copy(const ScrPerfEntry *e) {
  return (ScrPerfEntry){scr_str_retain(e->name),
                        scr_dyn_retain(e->detail),
                        e->ref ? scr_dyn_retain(e->ref) : NULL,
                        e->start,
                        e->duration,
                        e->measure,
                        e->id};
}

typedef struct ScrPerfObserver {
  size_t refs;
  ScrDyn *cb;       /* owned */
  ScrStr **types;   /* owned; the observed entry types, insertion order */
  size_t ntypes, types_cap;
  int mode;         /* 0 unset, 1 single (type), 2 multiple (entryTypes) */
  ScrPerfEntries buffer;
  bool pending;     /* in the pending set */
  bool connected;   /* in the observers set */
} ScrPerfObserver;

typedef struct {
  size_t refs;
  ScrPerfEntries entries; /* owned; sorted by startTime when built */
} ScrPerfList;

static SCR_TL ScrPerfObserver **scr_perf_observers;
static SCR_TL size_t scr_perf_nobservers, scr_perf_observers_cap;
static SCR_TL ScrPerfObserver **scr_perf_pending;
static SCR_TL size_t scr_perf_npending, scr_perf_pending_cap;
static SCR_TL bool scr_perf_dispatch_scheduled;
static SCR_TL bool scr_perf_observer_installed;

static const char *const scr_perf_supported_types[] = {"dns",   "function", "gc",       "http", "http2",
                                                       "mark",  "measure",  "net",      "quic", "resource"};

static bool scr_perf_supported_type(const ScrStr *name) {
  for (size_t i = 0; i < sizeof scr_perf_supported_types / sizeof scr_perf_supported_types[0]; i++) {
    const char *type = scr_perf_supported_types[i];
    if (name->len == strlen(type) && memcmp(name->data, type, name->len) == 0) return true;
  }
  return false;
}

static ScrPerfObserver *scr_perf_observer_retain(ScrPerfObserver *o) {
  o->refs++;
  return o;
}

static void scr_perf_observer_release(ScrPerfObserver *o) {
  if (!o || --o->refs != 0) return;
  scr_dyn_release(o->cb);
  for (size_t i = 0; i < o->ntypes; i++) scr_str_release(o->types[i]);
  free(o->types);
  scr_perf_entries_clear(&o->buffer);
  free(o->buffer.items);
  free(o);
}

static ScrPerfList *scr_perf_list_retain(ScrPerfList *l) {
  l->refs++;
  return l;
}

static void scr_perf_list_release(ScrPerfList *l) {
  if (!l || --l->refs != 0) return;
  scr_perf_entries_clear(&l->entries);
  free(l->entries.items);
  free(l);
}

static void scr_perf_observer_type_add(ScrPerfObserver *o, const ScrStr *name) {
  for (size_t i = 0; i < o->ntypes; i++)
    if (scr_str_eq(o->types[i], (ScrStr *)name)) return;
  if (o->ntypes == o->types_cap) {
    size_t cap = o->types_cap ? o->types_cap * 2 : 4;
    ScrStr **types = realloc(o->types, cap * sizeof *types);
    if (!types) scr_trap("scriptc: out of memory\n");
    o->types = types;
    o->types_cap = cap;
  }
  o->types[o->ntypes++] = scr_str_retain((ScrStr *)name);
}

static bool scr_perf_observer_has_type(const ScrPerfObserver *o, const ScrStr *type) {
  for (size_t i = 0; i < o->ntypes; i++)
    if (scr_str_eq(o->types[i], (ScrStr *)type)) return true;
  return false;
}

static void scr_perf_observer_types_clear(ScrPerfObserver *o) {
  for (size_t i = 0; i < o->ntypes; i++) scr_str_release(o->types[i]);
  o->ntypes = 0;
}

/* Removes `o` from a registry, releasing the membership's reference. */
static void scr_perf_registry_remove(ScrPerfObserver ***items, size_t *len, ScrPerfObserver *o) {
  for (size_t i = 0; i < *len; i++) {
    if ((*items)[i] != o) continue;
    memmove(&(*items)[i], &(*items)[i + 1], (*len - i - 1) * sizeof **items);
    (*len)--;
    scr_perf_observer_release(o);
    return;
  }
}

static void scr_perf_dispatch_tick(ScrClosure *cb);

static void scr_perf_dispatch_schedule(void) {
  if (scr_perf_dispatch_scheduled) return;
  scr_perf_dispatch_scheduled = true;
  scr_set_immediate(scr_closure_new((void *)scr_perf_dispatch_tick, 0));
}

static void scr_perf_observer_mark_pending(ScrPerfObserver *o) {
  if (!o->pending) {
    if (scr_perf_npending == scr_perf_pending_cap) {
      size_t cap = scr_perf_pending_cap ? scr_perf_pending_cap * 2 : 8;
      ScrPerfObserver **items = realloc(scr_perf_pending, cap * sizeof *items);
      if (!items) scr_trap("scriptc: out of memory\n");
      scr_perf_pending = items;
      scr_perf_pending_cap = cap;
    }
    scr_perf_pending[scr_perf_npending++] = scr_perf_observer_retain(o);
    o->pending = true;
  }
  scr_perf_dispatch_schedule();
}

static void scr_perf_observer_connect(ScrPerfObserver *o) {
  if (o->connected) return;
  if (scr_perf_nobservers == scr_perf_observers_cap) {
    size_t cap = scr_perf_observers_cap ? scr_perf_observers_cap * 2 : 8;
    ScrPerfObserver **items = realloc(scr_perf_observers, cap * sizeof *items);
    if (!items) scr_trap("scriptc: out of memory\n");
    scr_perf_observers = items;
    scr_perf_observers_cap = cap;
  }
  scr_perf_observers[scr_perf_nobservers++] = scr_perf_observer_retain(o);
  o->connected = true;
}

/* disconnect(): the observers and pending memberships, the buffer, the
 * types and the mode all clear. */
static void scr_perf_observer_detach(ScrPerfObserver *o) {
  if (o->connected) {
    o->connected = false;
    scr_perf_registry_remove(&scr_perf_observers, &scr_perf_nobservers, o);
  }
  if (o->pending) {
    o->pending = false;
    scr_perf_registry_remove(&scr_perf_pending, &scr_perf_npending, o);
  }
  scr_perf_entries_clear(&o->buffer);
  scr_perf_observer_types_clear(o);
  o->mode = 0;
}

static void scr_perf_observers_cleanup(void) {
  /* The registries own one reference per membership; nothing else exists
   * once the program has ended. */
  while (scr_perf_nobservers) scr_perf_observer_release(scr_perf_observers[--scr_perf_nobservers]);
  while (scr_perf_npending) scr_perf_observer_release(scr_perf_pending[--scr_perf_npending]);
  free(scr_perf_observers);
  free(scr_perf_pending);
  scr_perf_observers = NULL;
  scr_perf_pending = NULL;
  scr_perf_observers_cap = scr_perf_pending_cap = 0;
  scr_perf_dispatch_scheduled = false;
}

/* observe.js's enqueue, over the buffered entry the timeline just took. */
static void scr_perf_observers_enqueue(const ScrPerfEntry *entry) {
  if (scr_perf_nobservers == 0) return;
  ScrStr *name = entry->measure ? scr_str_new("measure", 7) : scr_str_new("mark", 4);
  for (size_t i = 0; i < scr_perf_nobservers; i++) {
    ScrPerfObserver *o = scr_perf_observers[i];
    if (!scr_perf_observer_has_type(o, name)) continue;
    scr_perf_entries_push(&o->buffer, scr_perf_entry_copy(entry));
    scr_perf_observer_mark_pending(o);
  }
  scr_str_release(name);
}

/* The program's object for entry `id`, once the producing call returned:
 * the copies enqueued before it existed answer it too. */
static void scr_perf_observers_adopt_kept(size_t id, ScrDyn *ref) {
  for (size_t i = 0; i < scr_perf_nobservers; i++) {
    ScrPerfObserver *o = scr_perf_observers[i];
    for (size_t j = 0; j < o->buffer.len; j++) {
      ScrPerfEntry *copy = &o->buffer.items[j];
      if (copy->id != id || copy->ref) continue;
      copy->ref = scr_dyn_retain(ref);
    }
  }
}

/* The registered observers' pending sets, snapshotted at the tick: each
 * one's buffered entries become its entry list and its callback runs. */
static void scr_perf_dispatch_tick(ScrClosure *cb) {
  (void)cb;
  scr_perf_dispatch_scheduled = false;
  size_t n = scr_perf_npending;
  if (n == 0) return;
  ScrPerfObserver **pend = malloc(n * sizeof *pend);
  if (!pend) scr_trap("scriptc: out of memory\n");
  /* The snapshot takes the pending set's references. */
  memcpy(pend, scr_perf_pending, n * sizeof *pend);
  scr_perf_npending = 0;
  for (size_t i = 0; i < n; i++) pend[i]->pending = false;
  for (size_t i = 0; i < n; i++) {
    ScrPerfObserver *o = pend[i];
    ScrPerfList *list = malloc(sizeof *list);
    if (!list) scr_trap("scriptc: out of memory\n");
    list->refs = 1;
    list->entries = o->buffer;
    o->buffer = (ScrPerfEntries){0};
    scr_perf_sort(list->entries.items, list->entries.len);
    ScrDyn *list_box = scr_dyn_new_handle(list, SCR_DYNH_PERF_ENTRY_LIST);
    scr_perf_list_release(list);
    ScrDyn *self = scr_dyn_new_handle(o, SCR_DYNH_PERF_OBSERVER);
    ScrDyn *args[2] = {list_box, self};
    ScrDyn *result = scr_dyn_call(o->cb, args, 2, "callback");
    scr_dyn_release(list_box);
    scr_dyn_release(self);
    scr_perf_observer_release(o);
    if (result) scr_dyn_release(result);
    if (scr_exc_pending()) {
      for (size_t j = i + 1; j < n; j++) scr_perf_observer_release(pend[j]);
      free(pend);
      return;
    }
  }
  free(pend);
}

/* ── the handles ─────────────────────────────────────────────────────── */

static ScrDyn *scr_perf_handle_get(void *h, const char *key, size_t len) {
  (void)h;
  (void)key;
  (void)len;
  return NULL; /* no modeled properties: reads answer undefined */
}

static void *scr_perf_observer_op_retain(void *h) { return scr_perf_observer_retain(h); }
static void scr_perf_observer_op_release(void *h) { scr_perf_observer_release(h); }
static void *scr_perf_list_op_retain(void *h) { return scr_perf_list_retain(h); }
static void scr_perf_list_op_release(void *h) { scr_perf_list_release(h); }

static void scr_perf_invalid_this(const char *cls) {
  char msg[96];
  int n = snprintf(msg, sizeof msg, "Value of \"this\" must be of type %s", cls);
  scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)n, "ERR_INVALID_THIS");
}

/* An array member of a converted object arrives as a live array CAPSULE
 * (the conversion keeps array identity), not a plain dyn array;
 * materialize it so the observer reads it like one. +1, or NULL with the
 * exception pending. */
static ScrDyn *scr_perf_array_member(ScrDyn *object, const char *key) {
  ScrDyn *value = scr_perf_member(object, key);
  if (!value || value->kind != SCR_DYN_TYPED_REF || !scr_dyn_ref_is_array(value)) return value;
  ScrDyn *view = scr_dyn_typed_ref_materialize(value);
  scr_dyn_release(value);
  return view;
}

/* The entry list's answer: `which` 0 getEntries, 1 getEntriesByName,
 * 2 getEntriesByType. Node requires the name/type argument, coerces it
 * with a template literal, and compares the optional type without
 * coercing it (a non-string matches no entry type). */
static double scr_perf_list_select(const ScrPerfEntries *l, ScrDyn *args, double which) {
  ScrStr *name = NULL, *type = NULL;
  bool have_type = false;
  ScrDyn *type_value = NULL;
  if (which == 1) {
    if (!args || args->kind != SCR_DYN_ARR || args->v.arr.len == 0) {
      scr_perf_missing("name");
      return 0;
    }
    if (!(name = scr_perf_string(scr_perf_arg(args, 0)))) return 0;
    type_value = scr_perf_arg(args, 1);
    have_type = !scr_perf_nullish(type_value);
  } else if (which == 2) {
    if (!args || args->kind != SCR_DYN_ARR || args->v.arr.len == 0) {
      scr_perf_missing("type");
      return 0;
    }
    if (!(type = scr_perf_string(scr_perf_arg(args, 0)))) return 0;
  }
  scr_perf_view_len = 0;
  for (size_t i = 0; i < l->len; i++) {
    const ScrPerfEntry *e = &l->items[i];
    if (name && !scr_str_eq(e->name, name)) continue;
    if (which == 1 && have_type) {
      ScrStr *own = e->measure ? scr_str_new("measure", 7) : scr_str_new("mark", 4);
      bool equal = type_value->kind == SCR_DYN_STR && scr_str_eq(own, type_value->v.str);
      scr_str_release(own);
      if (!equal) continue;
    }
    if (which == 2) {
      ScrStr *own = e->measure ? scr_str_new("measure", 7) : scr_str_new("mark", 4);
      bool equal = scr_str_eq(own, type);
      scr_str_release(own);
      if (!equal) continue;
    }
    scr_perf_view_reserve(scr_perf_view_len + 1);
    scr_perf_view[scr_perf_view_len++] = *e;
  }
  scr_str_release(name);
  scr_str_release(type);
  return (double)scr_perf_view_len;
}

/* The JavaScript-typed path (`list.getEntries()` on a dyn value): the
 * entries Node's list answers. An entry the producing call kept is the
 * program's own object, and Node's selectors answer those same objects on
 * every call; only a copy without one (an entry that reached the list
 * without a program object) is built fresh. */
static ScrDyn *scr_perf_entry_object(const ScrPerfEntry *e) {
  if (e->ref) return scr_dyn_retain(e->ref);
  ScrDyn *object = scr_dyn_new_obj();
  scr_dyn_obj_set(object, "name", 4, scr_dyn_new_str(e->name));
  ScrStr *type = e->measure ? scr_str_new("measure", 7) : scr_str_new("mark", 4);
  scr_dyn_obj_set(object, "entryType", 9, scr_dyn_new_str(type));
  scr_str_release(type);
  scr_dyn_obj_set(object, "startTime", 9, scr_dyn_new_num(e->start));
  scr_dyn_obj_set(object, "duration", 8, scr_dyn_new_num(e->duration));
  scr_dyn_obj_set(object, "detail", 6, scr_dyn_retain(e->detail));
  /* The object is a PerformanceMark or PerformanceMeasure instance: its
   * class prototype (scr_json.c's dyn core). */
  scr_dyn_perf_entry_finish(object);
  return object;
}

static ScrDyn *scr_perf_list_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args,
                                    size_t argc, const char *what) {
  (void)self;
  ScrPerfList *list = h;
  double which = -1;
  if (strcmp(method, "getEntries") == 0) which = 0;
  else if (strcmp(method, "getEntriesByName") == 0) which = 1;
  else if (strcmp(method, "getEntriesByType") == 0) which = 2;
  if (which < 0) {
    char buf[256];
    int n = snprintf(buf, sizeof buf, "%s is not a function", what && *what ? what : method);
    scr_throw_error_msg(SCR_ERR_TYPE, buf, (size_t)n);
    return NULL;
  }
  ScrDyn *packed = scr_dyn_new_arr();
  for (size_t i = 0; i < argc; i++) scr_dyn_arr_push(packed, scr_dyn_retain(args[i]));
  double count = scr_perf_list_select(&list->entries, packed, which);
  scr_dyn_release(packed);
  if (scr_exc_pending()) return NULL;
  ScrDyn *out = scr_dyn_new_arr();
  for (double i = 0; i < count; i++)
    scr_dyn_arr_push(out, scr_perf_entry_object(&scr_perf_view[(size_t)i]));
  return out;
}

static ScrDyn *scr_perf_observer_invoke(void *h, ScrDyn *self, const char *method, ScrDyn *const *args,
                                        size_t argc, const char *what) {
  (void)self;
  ScrPerfObserver *o = h;
  if (strcmp(method, "observe") == 0) {
    ScrDyn *packed = scr_dyn_new_arr();
    for (size_t i = 0; i < argc; i++) scr_dyn_arr_push(packed, scr_dyn_retain(args[i]));
    ScrDyn *box = scr_dyn_new_handle(o, SCR_DYNH_PERF_OBSERVER);
    scr_perf_observer_observe(box, packed);
    scr_dyn_release(box);
    scr_dyn_release(packed);
    return scr_exc_pending() ? NULL : scr_dyn_undefined();
  }
  if (strcmp(method, "disconnect") == 0) {
    scr_perf_observer_detach(o);
    return scr_dyn_undefined();
  }
  if (strcmp(method, "takeRecords") == 0) {
    ScrDyn *box = scr_dyn_new_handle(o, SCR_DYNH_PERF_OBSERVER);
    double count = scr_perf_observer_take(box);
    scr_dyn_release(box);
    if (scr_exc_pending()) return NULL;
    ScrDyn *out = scr_dyn_new_arr();
    for (double i = 0; i < count; i++)
      scr_dyn_arr_push(out, scr_perf_entry_object(&scr_perf_view[(size_t)i]));
    return out;
  }
  char buf[256];
  int n = snprintf(buf, sizeof buf, "%s is not a function", what && *what ? what : method);
  scr_throw_error_msg(SCR_ERR_TYPE, buf, (size_t)n);
  return NULL;
}

static const ScrDynHandleMethod scr_perf_observer_methods[] = {
    {"observe", 1, false, NULL},
    {"disconnect", 0, false, NULL},
    {"takeRecords", 0, false, NULL},
    {NULL, 0, false, NULL},
};

static const ScrDynHandleMethod scr_perf_list_methods[] = {
    {"getEntries", 0, false, NULL},
    {"getEntriesByType", 1, false, NULL},
    {"getEntriesByName", 2, false, NULL},
    {NULL, 0, false, NULL},
};

static const ScrDynHandleOps scr_perf_observer_ops = {
    .cls = "PerformanceObserver",
    .retain = scr_perf_observer_op_retain,
    .release = scr_perf_observer_op_release,
    .invoke = scr_perf_observer_invoke,
    .get = scr_perf_handle_get,
    .json_empty_object = true,
    .to_string_tag = "PerformanceObserver",
    .methods = scr_perf_observer_methods,
};

static const ScrDynHandleOps scr_perf_list_ops = {
    .cls = "PerformanceObserverEntryList",
    .retain = scr_perf_list_op_retain,
    .release = scr_perf_list_op_release,
    .invoke = scr_perf_list_invoke,
    .get = scr_perf_handle_get,
    .json_empty_object = true,
    .to_string_tag = "PerformanceObserverEntryList",
    .methods = scr_perf_list_methods,
};

static void scr_perf_observer_install(void) {
  if (scr_perf_observer_installed) return;
  scr_perf_observer_installed = true;
  scr_dyn_handle_install(SCR_DYNH_PERF_OBSERVER, &scr_perf_observer_ops);
  scr_dyn_handle_install(SCR_DYNH_PERF_ENTRY_LIST, &scr_perf_list_ops);
}

/* ── the compiler's entry points ─────────────────────────────────────── */

ScrDyn *scr_perf_observer_new(ScrDyn *args) {
  scr_perf_observer_install();
  if (!scr_perf_args_ok(args, "PerformanceObserver")) return NULL;
  ScrDyn *callback = scr_perf_arg(args, 0);
  if (!scr_dyn_is_callable(callback)) {
    scr_dyn_arg_type_fail("callback", "of type function", callback);
    return NULL;
  }
  ScrPerfObserver *o = malloc(sizeof *o);
  if (!o) scr_trap("scriptc: out of memory\n");
  memset(o, 0, sizeof *o);
  o->refs = 1;
  o->cb = scr_dyn_retain(callback);
  scr_perf_arm();
  ScrDyn *box = scr_dyn_new_handle(o, SCR_DYNH_PERF_OBSERVER);
  scr_perf_observer_release(o);
  return box;
}

/* The `entryTypes` members that name a supported type. */
static void scr_perf_observer_add_types(ScrPerfObserver *o, const ScrDyn *entryTypes) {
  for (size_t i = 0; i < entryTypes->v.arr.len; i++) {
    const ScrDyn *item = entryTypes->v.arr.items[i];
    if (item->kind == SCR_DYN_STR && scr_perf_supported_type(item->v.str))
      scr_perf_observer_type_add(o, item->v.str);
  }
}

void scr_perf_observer_observe(ScrDyn *observer, ScrDyn *args) {
  scr_perf_observer_install();
  if (!observer || observer->kind != SCR_DYN_HANDLE ||
      observer->v.handle.tag != SCR_DYNH_PERF_OBSERVER) {
    scr_perf_invalid_this("PerformanceObserver");
    return;
  }
  ScrPerfObserver *o = observer->v.handle.ptr;
  ScrDyn *options = scr_perf_arg(args, 0);
  /* observe() and observe(undefined) are the missing-options form; null
   * is a present value of the wrong type (Node validates null as
   * `object`). */
  bool empty = options->kind == SCR_DYN_UNDEF;
  if (!empty && (options->kind == SCR_DYN_ARR || !scr_dyn_is_object(options))) {
    scr_dyn_arg_type_fail("options", "of type object", options);
    return;
  }
  ScrDyn *entry_types = empty ? NULL : scr_perf_array_member(options, "entryTypes");
  if (!empty && !entry_types) return;
  ScrDyn *type = empty ? NULL : scr_perf_member(options, "type");
  if (!empty && !type) {
    scr_dyn_release(entry_types);
    return;
  }
  ScrDyn *buffered = empty ? NULL : scr_perf_member(options, "buffered");
  if (!empty && !buffered) {
    scr_dyn_release(entry_types);
    scr_dyn_release(type);
    return;
  }
  bool has_entry_types = entry_types && entry_types->kind != SCR_DYN_UNDEF;
  bool has_type = type && type->kind != SCR_DYN_UNDEF;
  bool entry_types_present = entry_types && !scr_perf_nullish(entry_types);
  bool type_present = type && !scr_perf_nullish(type);
  if (!has_entry_types && !has_type) {
    static const char msg[] = "The \"options.entryTypes\" and \"options.type\" arguments must be specified";
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, sizeof msg - 1, "ERR_MISSING_ARGS");
    goto done;
  }
  if (entry_types_present && type_present) {
    scr_dyn_arg_value_fail("options.entryTypes",
                           "options.entryTypes can not set with options.type together", entry_types);
    goto done;
  }
  switch (o->mode) {
  case 0:
    if (has_entry_types) o->mode = 2;
    if (has_type) o->mode = 1;
    break;
  case 1:
    if (has_entry_types) {
      static const char msg[] = "PerformanceObserver can not change to multiple observations";
      scr_throw_domex_str("InvalidModificationError", scr_str_new(msg, sizeof msg - 1));
      goto done;
    }
    break;
  case 2:
    if (has_type) {
      static const char msg[] = "PerformanceObserver can not change to single observation";
      scr_throw_domex_str("InvalidModificationError", scr_str_new(msg, sizeof msg - 1));
      goto done;
    }
    break;
  }
  if (o->mode == 2) {
    if (!entry_types || entry_types->kind != SCR_DYN_ARR) {
      scr_dyn_prop_type_fail("options.entryTypes", "string[]",
                             entry_types ? entry_types : scr_dyn_undefined());
      goto done;
    }
    scr_perf_observer_types_clear(o);
    scr_perf_observer_add_types(o, entry_types);
  } else {
    if (!type || type->kind != SCR_DYN_STR || !scr_perf_supported_type(type->v.str)) goto done;
    scr_perf_observer_type_add(o, type->v.str);
    if (buffered && scr_dyn_truthy(buffered)) {
      /* Node pushes the parsed global buffer's entries, in insertion
       * order, for the single type: a marker of the historical entries. */
      ScrPerfBuffer *source = NULL;
      if (type->v.str->len == 4 && memcmp(type->v.str->data, "mark", 4) == 0)
        source = &scr_perf_marks;
      else if (type->v.str->len == 7 && memcmp(type->v.str->data, "measure", 7) == 0)
        source = &scr_perf_measures;
      if (source) {
        size_t first = o->buffer.len;
        for (size_t i = 0; i < source->len; i++)
          scr_perf_entries_push(&o->buffer, scr_perf_entry_copy(&source->items[i]));
        scr_perf_sort(&o->buffer.items[first], o->buffer.len - first);
      }
      scr_perf_observer_mark_pending(o);
    }
  }
  if (o->ntypes) {
    scr_perf_observer_connect(o);
  } else {
    scr_perf_observer_detach(o);
  }
done:
  scr_dyn_release(entry_types);
  scr_dyn_release(type);
  scr_dyn_release(buffered);
}

void scr_perf_observer_disconnect(ScrDyn *observer) {
  scr_perf_observer_install();
  if (!observer || observer->kind != SCR_DYN_HANDLE ||
      observer->v.handle.tag != SCR_DYNH_PERF_OBSERVER) {
    scr_perf_invalid_this("PerformanceObserver");
    return;
  }
  scr_perf_observer_detach(observer->v.handle.ptr);
}

double scr_perf_observer_take(ScrDyn *observer) {
  scr_perf_observer_install();
  if (!observer || observer->kind != SCR_DYN_HANDLE ||
      observer->v.handle.tag != SCR_DYNH_PERF_OBSERVER) {
    scr_perf_invalid_this("PerformanceObserver");
    return 0;
  }
  ScrPerfObserver *o = observer->v.handle.ptr;
  /* The previous answer stops being readable now; these entries take its
   * place. The previous answer's storage is freed rather than reused: the
   * observer's queue owns the allocation that takes its place. */
  scr_perf_entries_clear(&scr_perf_taken);
  free(scr_perf_taken.items);
  scr_perf_taken = (ScrPerfEntries){0};
  size_t n = o->buffer.len;
  if (n == 0) {
    scr_perf_view_len = 0;
    return 0;
  }
  /* The entries move out of the observer's queue: the view borrows them
   * until the next timeline call. The pending dispatch stays queued: Node's
   * takeRecords empties the queue but does not cancel the tick, so the
   * callback still runs, with the (now empty) list. */
  scr_perf_taken = o->buffer;
  o->buffer = (ScrPerfEntries){0};
  scr_perf_view_reserve(n);
  for (size_t i = 0; i < n; i++) scr_perf_view[i] = scr_perf_taken.items[i];
  scr_perf_view_len = n;
  return (double)n;
}

double scr_perf_list_entries(ScrDyn *list, ScrDyn *args, double which) {
  scr_perf_observer_install();
  if (!list || list->kind != SCR_DYN_HANDLE || list->v.handle.tag != SCR_DYNH_PERF_ENTRY_LIST) {
    scr_perf_invalid_this("PerformanceObserverEntryList");
    return 0;
  }
  return scr_perf_list_select(&((ScrPerfList *)list->v.handle.ptr)->entries, args, which);
}
