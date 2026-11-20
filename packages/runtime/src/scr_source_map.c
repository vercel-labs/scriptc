/* node:module's SourceMap class — lib/internal/source_map/source_map.js, a
 * port of v8's tools/SourceMap.js.
 *
 * A SourceMap is a native checked-dynamic handle: its payload reads through
 * the handle, findEntry and findOrigin dispatch through it, and instanceof
 * is lowered to scr_source_map_is. `new SourceMap(payload)` (lowered in
 * builtins/source-map.ts) builds the handle here.
 *
 * The payload is copied the way Node copies it: a new plain object whose own
 * enumerable properties are the payload's, with every array-valued field
 * sliced. The mappings string is parsed once at construction into generated
 * (line, column) ranges that keep the original source URL and name they
 * resolved (a section's ranges name that section's sources), sorted as Node
 * sorts them; findEntry binary-searches that list and findOrigin adds the
 * offsets back.
 *
 * A unit of its own, linked only by a program that names module.SourceMap
 * (the compiler's `sourceMap` runtime feature), so no other executable
 * changes. */
#include "scr_runtime.h"

#include <stdlib.h>
#include <string.h>

typedef struct {
  int64_t generated_line;
  int64_t generated_column;
  int64_t original_line;
  int64_t original_column;
  /* Owned; NULL when the segment names no source (a one-field segment), as
   * Node's missing originalSource/originalLine/originalColumn. */
  ScrStr *source;
  /* Owned; NULL when the segment carries no name. */
  ScrStr *name;
  /* The segment carried the source and original-position fields (a
   * one-field segment did not), whatever its source index resolved to. */
  bool has_origin;
} ScrSourceMapRange;

typedef struct {
  size_t rc;
  /* The constructor's shallow clone (owned). */
  ScrDyn *payload;
  ScrSourceMapRange *ranges;
  size_t range_count;
  size_t range_cap;
} ScrSourceMap;

static void *scr_source_map_retain(void *ptr) {
  ScrSourceMap *map = ptr;
  map->rc++;
  return map;
}

static void scr_source_map_release(void *ptr) {
  ScrSourceMap *map = ptr;
  if (--map->rc) return;
  scr_dyn_release(map->payload);
  for (size_t i = 0; i < map->range_count; i++) {
    if (map->ranges[i].source) scr_str_release(map->ranges[i].source);
    if (map->ranges[i].name) scr_str_release(map->ranges[i].name);
  }
  free(map->ranges);
  free(map);
}

/* Reads `key` off a payload the way a property read in the program does: a
 * checked record boxed as a dynamic value answers from its native fields or
 * its view. NULL with the error pending when a getter throws. */
static ScrDyn *scr_source_map_member(const ScrDyn *object, const char *key, size_t key_len) {
  if (object->kind != SCR_DYN_TYPED_REF) return scr_dyn_obj_read(object, key, key_len);
  ScrStr *name = scr_str_new(key, key_len);
  ScrDyn *value = scr_dyn_typed_ref_own_get(object, name);
  if (!value) {
    ScrDyn *view = scr_dyn_typed_ref_materialize(object);
    if (view) {
      value = scr_dyn_obj_read(view, key, key_len);
      scr_dyn_release(view);
    }
  }
  scr_str_release(name);
  return value;
}

/* Array.prototype.slice() of an array value: a fresh array holding the same
 * elements. The payload's arrays may be plain checked arrays or the live
 * capsule a typed record's array field boxes into; both read through the
 * generic element accessors. Any other value is retained as it is. */
static ScrDyn *scr_source_map_slice_value(ScrDyn *value) {
  if (value->kind != SCR_DYN_ARR && !scr_dyn_ref_is_array(value))
    return scr_dyn_retain(value);
  ScrDyn *copy = scr_dyn_new_arr();
  size_t count = (size_t)scr_dyn_arr_len(value);
  for (size_t i = 0; i < count; i++) scr_dyn_arr_push(copy, scr_dyn_arr_at(value, (double)i));
  return copy;
}

/* Node's cloneSourceMapV3: { ...payload }, with each array-valued own
 * enumerable property sliced. Own entries are read in own-key order, so the
 * clone's keys keep the payload's order. */
static ScrDyn *scr_source_map_clone_payload(const ScrDyn *payload) {
  ScrDynEntryPairs *pairs = scr_dyn_obj_entry_pairs(payload);
  if (pairs == NULL) return NULL;
  ScrDyn *clone = scr_dyn_new_obj();
  for (size_t i = 0; i < pairs->count; i++) {
    ScrDynEntryPair *pair = &pairs->pairs[i];
    ScrDyn *value = scr_source_map_slice_value(pair->value);
    scr_dyn_obj_set(clone, pair->key->data, pair->key->len, value);
  }
  /* The snapshot owns a reference to every key and value it lists. The keys
   * were only read, and each value's reference was either retained (copied
   * into the clone as a new reference) or sliced (the clone holds its own
   * array), so both references are released here; freeing the snapshot
   * frees only its array. */
  for (size_t i = 0; i < pairs->count; i++) {
    scr_str_release(pairs->pairs[i].key);
    scr_dyn_release(pairs->pairs[i].value);
  }
  scr_dyn_entry_pairs_free(pairs);
  return clone;
}

/* The base64 digit of a VLQ character, and the end-of-string 0 Node's
 * StringCharIterator spells as "" (whose digit is undefined, which the
 * decoder's masks read as zero). */
static int scr_source_map_digit(const ScrStr *mappings, size_t *pos) {
  if (*pos >= mappings->len) {
    (*pos)++;
    return 0;
  }
  unsigned char c = (unsigned char)mappings->data[(*pos)++];
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  return 0;
}

static int64_t scr_source_map_decode_vlq(const ScrStr *mappings, size_t *pos) {
  uint64_t result = 0;
  unsigned shift = 0;
  int digit;
  do {
    digit = scr_source_map_digit(mappings, pos);
    result += (uint64_t)(digit & 31) << shift;
    shift += 5;
  } while (digit & 32);
  bool negative = (result & 1) != 0;
  result >>= 1;
  return negative ? -(int64_t)result : (int64_t)result;
}

static void scr_source_map_push(ScrSourceMap *map, ScrSourceMapRange range) {
  if (map->range_count == map->range_cap) {
    size_t cap = map->range_cap == 0 ? 16 : map->range_cap * 2;
    ScrSourceMapRange *grown = realloc(map->ranges, cap * sizeof *grown);
    if (!grown) scr_trap("scriptc: out of memory\n");
    map->ranges = grown;
    map->range_cap = cap;
  }
  map->ranges[map->range_count++] = range;
}

/* The string value `value` holds (+1), through a typed record's view when
 * that is how the field was boxed; NULL for anything else. */
static ScrStr *scr_source_map_string(const ScrDyn *value) {
  if (value->kind == SCR_DYN_STR) return scr_str_retain(value->v.str);
  if (value->kind != SCR_DYN_TYPED_REF) return NULL;
  ScrDyn *view = scr_dyn_typed_ref_materialize(value);
  if (view == NULL) return NULL;
  ScrStr *text = view->kind == SCR_DYN_STR ? scr_str_retain(view->v.str) : NULL;
  scr_dyn_release(view);
  return text;
}

/* The string element `index` of an array value (+1), or NULL. */
static ScrStr *scr_source_map_array_string(const ScrDyn *array, int32_t index) {
  if (index < 0) return NULL;
  ScrDyn *item = scr_dyn_arr_at(array, (double)index);
  ScrStr *text = item != NULL ? scr_source_map_string(item) : NULL;
  scr_dyn_release(item);
  return text;
}

static bool scr_source_map_separator(const ScrStr *mappings, size_t pos) {
  if (pos >= mappings->len) return false;
  char c = mappings->data[pos];
  return c == ',' || c == ';';
}

/* One map object's mappings, at the section's offsets (Node's #parseMap).
 * The ranges keep the source URL and name each segment resolves here, so a
 * section's ranges name that section's own sources. */
static void scr_source_map_parse(ScrSourceMap *map, const ScrDyn *payload, int64_t line_number,
                                 int64_t column_number) {
  ScrDyn *sources = scr_source_map_member(payload, "sources", 7);
  if (sources == NULL) return;
  ScrDyn *mappings = scr_source_map_member(payload, "mappings", 8);
  if (mappings == NULL) {
    scr_dyn_release(sources);
    return;
  }
  size_t source_count = (size_t)scr_dyn_arr_len(sources);
  ScrDyn *names = scr_source_map_member(payload, "names", 5);
  int64_t source_index = 0;
  int64_t source_line_number = 0;
  int64_t source_column_number = 0;
  int64_t name_index = 0;
  ScrStr *text = scr_source_map_string(mappings);
  size_t pos = 0;
  while (text != NULL) {
    if (pos < text->len && text->data[pos] == ',') {
      pos++;
    } else {
      while (pos < text->len && text->data[pos] == ';') {
        line_number += 1;
        column_number = 0;
        pos++;
      }
      if (pos >= text->len) break;
    }
    column_number += scr_source_map_decode_vlq(text, &pos);
    ScrSourceMapRange range = {line_number, column_number, 0, 0, NULL, NULL, false};
    if (scr_source_map_separator(text, pos)) {
      scr_source_map_push(map, range);
      continue;
    }
    int64_t source_delta = scr_source_map_decode_vlq(text, &pos);
    if (source_delta != 0) source_index += source_delta;
    /* Node keeps the running index even past the list (the URL answers
     * undefined then) and applies later deltas to it. */
    range.has_origin = true;
    if (source_index >= 0 && (size_t)source_index < source_count)
      range.source = scr_source_map_array_string(sources, (int32_t)source_index);
    source_line_number += scr_source_map_decode_vlq(text, &pos);
    source_column_number += scr_source_map_decode_vlq(text, &pos);
    range.original_line = source_line_number;
    range.original_column = source_column_number;
    if (!scr_source_map_separator(text, pos)) {
      name_index += scr_source_map_decode_vlq(text, &pos);
      if (names != NULL) range.name = scr_source_map_array_string(names, (int32_t)name_index);
    }
    scr_source_map_push(map, range);
  }
  scr_dyn_release(sources);
  scr_dyn_release(mappings);
  scr_dyn_release(names);
  scr_str_release(text);
}

/* Whether `a` sorts before `b` by generated line, then column. */
static bool scr_source_map_entry_before(const ScrSourceMapRange *a, const ScrSourceMapRange *b) {
  if (a->generated_line != b->generated_line) return a->generated_line < b->generated_line;
  return a->generated_column < b->generated_column;
}

/* A stable sort by generated line, then column (Node's Array.prototype.sort
 * over the parsed ranges, whose order is stable). A bottom-up merge sort:
 * a mapping may name its segments in any column order (delta coding allows
 * negative columns), so a quadratic sort would be reachable from a large
 * valid document. An already ordered list, the common case, is left as it
 * is. */
static void scr_source_map_sort(ScrSourceMap *map) {
  size_t n = map->range_count;
  if (n < 2) return;
  bool ordered = true;
  for (size_t i = 1; i < n && ordered; i++)
    if (scr_source_map_entry_before(&map->ranges[i], &map->ranges[i - 1])) ordered = false;
  if (ordered) return;
  if (n > SIZE_MAX / sizeof(ScrSourceMapRange)) scr_trap("scriptc: out of memory\n");
  ScrSourceMapRange *scratch = malloc(n * sizeof *scratch);
  if (!scratch) scr_trap("scriptc: out of memory\n");
  ScrSourceMapRange *src = map->ranges;
  ScrSourceMapRange *dst = scratch;
  for (size_t width = 1; width < n; width = width > n / 2 ? n : width * 2) {
    for (size_t start = 0; start < n; start += 2 * width) {
      size_t mid = start + width < n ? start + width : n;
      size_t end = start + 2 * width < n ? start + 2 * width : n;
      size_t left = start, right = mid, out = start;
      while (left < mid && right < end) {
        /* Ties take the left run, so equal ranges keep source order. */
        if (scr_source_map_entry_before(&src[right], &src[left]))
          dst[out++] = src[right++];
        else
          dst[out++] = src[left++];
      }
      while (left < mid) dst[out++] = src[left++];
      while (right < end) dst[out++] = src[right++];
    }
    ScrSourceMapRange *swap = src;
    src = dst;
    dst = swap;
  }
  if (src != map->ranges) memcpy(map->ranges, src, n * sizeof *src);
  free(scratch);
}

static void scr_source_map_build(ScrSourceMap *map) {
  ScrDyn *sections = scr_source_map_member(map->payload, "sections", 8);
  if (sections == NULL) return;
  /* Node takes the sections branch for any truthy `sections` (an empty array
   * included), so that payload carries whichever sections it lists. */
  if (scr_dyn_truthy(sections)) {
    size_t section_count = (size_t)scr_dyn_arr_len(sections);
    for (size_t i = 0; i < section_count; i++) {
      ScrDyn *section = scr_dyn_arr_at(sections, (double)i);
      if (section == NULL) continue;
      ScrDyn *inner = scr_source_map_member(section, "map", 3);
      ScrDyn *offset = scr_source_map_member(section, "offset", 6);
      if (inner == NULL || offset == NULL) {
        scr_dyn_release(inner);
        scr_dyn_release(offset);
        scr_dyn_release(section);
        continue;
      }
      ScrDyn *line = scr_source_map_member(offset, "line", 4);
      ScrDyn *column = scr_source_map_member(offset, "column", 6);
      int64_t line_number = line && line->kind == SCR_DYN_NUM ? (int64_t)line->v.num : 0;
      int64_t column_number = column && column->kind == SCR_DYN_NUM ? (int64_t)column->v.num : 0;
      scr_dyn_release(line);
      scr_dyn_release(column);
      scr_source_map_parse(map, inner, line_number, column_number);
      scr_dyn_release(inner);
      scr_dyn_release(offset);
      scr_dyn_release(section);
    }
  } else {
    scr_source_map_parse(map, map->payload, 0, 0);
  }
  scr_dyn_release(sections);
  scr_source_map_sort(map);
}

/* Node's findEntry binary search over the sorted ranges: the last range at or
 * before (line, column), or NULL when the point precedes the first range. */
static ScrSourceMapRange *scr_source_map_lookup(ScrSourceMap *map, double line_offset,
                                                double column_offset) {
  if (map->range_count == 0) return NULL;
  size_t first = 0;
  size_t count = map->range_count;
  while (count > 1) {
    size_t step = count >> 1;
    size_t middle = first + step;
    ScrSourceMapRange *range = &map->ranges[middle];
    if (line_offset < (double)range->generated_line ||
        (line_offset == (double)range->generated_line &&
         column_offset < (double)range->generated_column)) {
      count = step;
    } else {
      first = middle;
      count -= step;
    }
  }
  ScrSourceMapRange *entry = &map->ranges[first];
  if (first == 0 && (line_offset < (double)entry->generated_line ||
                     (line_offset == (double)entry->generated_line &&
                      column_offset < (double)entry->generated_column)))
    return NULL;
  return entry;
}

static ScrDyn *scr_source_map_source_value(const ScrSourceMapRange *range) {
  return range->source ? scr_dyn_new_str(range->source) : scr_dyn_undefined();
}

static ScrDyn *scr_source_map_name_value(const ScrSourceMapRange *range) {
  return range->name ? scr_dyn_new_str(range->name) : scr_dyn_undefined();
}

/* findEntry's answer: the range's fields, every key present (undefined where
 * the segment carries no source or name). */
static ScrDyn *scr_source_map_entry_answer(const ScrSourceMapRange *range) {
  ScrDyn *answer = scr_dyn_new_obj();
  scr_dyn_obj_set(answer, "generatedLine", 13, scr_dyn_new_num((double)range->generated_line));
  scr_dyn_obj_set(answer, "generatedColumn", 15, scr_dyn_new_num((double)range->generated_column));
  scr_dyn_obj_set(answer, "originalSource", 14, scr_source_map_source_value(range));
  scr_dyn_obj_set(answer, "originalLine", 12,
                  range->has_origin ? scr_dyn_new_num((double)range->original_line)
                                    : scr_dyn_undefined());
  scr_dyn_obj_set(answer, "originalColumn", 14,
                  range->has_origin ? scr_dyn_new_num((double)range->original_column)
                                    : scr_dyn_undefined());
  scr_dyn_obj_set(answer, "name", 4, scr_source_map_name_value(range));
  return answer;
}

static double scr_source_map_argument(ScrDyn *const *args, size_t argc, size_t index) {
  return scr_dyn_number_coerce(index < argc ? args[index] : scr_dyn_undefined());
}

/* findOrigin's answer: the entry's origin with the call site's offset added
 * back, or an empty object when the range names no origin. */
static ScrDyn *scr_source_map_origin_answer(ScrSourceMap *map, double line_number,
                                            double column_number) {
  ScrSourceMapRange *range = scr_source_map_lookup(map, line_number - 1, column_number - 1);
  if (range == NULL || range->source == NULL) return scr_dyn_new_obj();
  ScrDyn *answer = scr_dyn_new_obj();
  scr_dyn_obj_set(answer, "name", 4, scr_source_map_name_value(range));
  scr_dyn_obj_set(answer, "fileName", 8, scr_source_map_source_value(range));
  double line_offset = line_number - (double)range->generated_line;
  double column_offset = column_number - (double)range->generated_column;
  scr_dyn_obj_set(answer, "lineNumber", 10,
                  scr_dyn_new_num((double)range->original_line + line_offset));
  scr_dyn_obj_set(answer, "columnNumber", 12,
                  scr_dyn_new_num((double)range->original_column + column_offset));
  return answer;
}

static ScrDyn *scr_source_map_get(void *ptr, const char *key, size_t len) {
  ScrSourceMap *map = ptr;
  if (len == 7 && memcmp(key, "payload", 7) == 0) return scr_source_map_clone_payload(map->payload);
  return NULL;
}

static bool scr_source_map_set(void *ptr, const char *key, size_t len, const ScrDyn *value) {
  (void)ptr;
  (void)key;
  (void)len;
  (void)value;
  return false;
}

static ScrDyn *scr_source_map_invoke(void *ptr, ScrDyn *self, const char *method,
                                     ScrDyn *const *args, size_t argc, const char *what) {
  ScrSourceMap *map = ptr;
  /* A detached method: Node's private-field access throws this TypeError. */
  if (self == NULL || self->kind != SCR_DYN_HANDLE ||
      self->v.handle.tag != SCR_DYNH_SOURCE_MAP) {
    static const char message[] = "Cannot read properties of undefined (reading '#mappings')";
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, NULL);
    return NULL;
  }
  if (strcmp(method, "findEntry") == 0) {
    ScrSourceMapRange *range = scr_source_map_lookup(
        map, scr_source_map_argument(args, argc, 0), scr_source_map_argument(args, argc, 1));
    return range == NULL ? scr_dyn_new_obj() : scr_source_map_entry_answer(range);
  }
  if (strcmp(method, "findOrigin") == 0)
    return scr_source_map_origin_answer(map, scr_source_map_argument(args, argc, 0),
                                        scr_source_map_argument(args, argc, 1));
  ScrJsonBuf message;
  scr_jb_init(&message);
  scr_jb_puts(&message, what);
  scr_jb_puts(&message, " is not a function");
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&message));
  return NULL;
}

/* util.inspect renders `SourceMap {}`: Node's class keeps its state in
 * private fields, so the instance shows no properties at any depth. */
static ScrDyn *scr_source_map_inspect_view(void *ptr) {
  (void)ptr;
  return scr_dyn_new_obj();
}

/* The two lookups read as function values too (`typeof map.findEntry`), routed
 * back to invoke on their receiver. */
static const ScrDynHandleMethod scr_source_map_methods[] = {
  {"findEntry", 2, false, NULL, NULL},
  {"findOrigin", 2, false, NULL, NULL},
  {NULL, 0, false, NULL, NULL},
};

static const ScrDynHandleOps scr_source_map_ops = {
  .cls = "SourceMap",
  .retain = scr_source_map_retain,
  .release = scr_source_map_release,
  .get = scr_source_map_get,
  .set = scr_source_map_set,
  .invoke = scr_source_map_invoke,
  .methods = scr_source_map_methods,
  .inspect_view = scr_source_map_inspect_view,
  .inspect_view_empty = true,
  /* JSON.stringify(map) is "{}": the handle has no own enumerable fields. */
  .json_empty_object = true,
};

/* validateObject(payload, 'payload'), then the copy and the parse. */
ScrDyn *scr_source_map_new(ScrDyn *payload, ScrDyn *options) {
  if (payload->kind == SCR_DYN_NULL || payload->kind == SCR_DYN_ARR ||
      !scr_dyn_is_object(payload)) {
    scr_dyn_arg_type_fail("payload", "of type object", payload);
    return NULL;
  }
  (void)options;
  ScrDyn *clone = scr_source_map_clone_payload(payload);
  if (clone == NULL) return NULL;
  ScrSourceMap *map = calloc(1, sizeof *map);
  if (!map) scr_trap("scriptc: out of memory\n");
  map->rc = 1;
  map->payload = clone;
  scr_source_map_build(map);
  scr_dyn_handle_install(SCR_DYNH_SOURCE_MAP, &scr_source_map_ops);
  ScrDyn *boxed = scr_dyn_new_handle(map, SCR_DYNH_SOURCE_MAP);
  scr_source_map_release(map);
  return boxed;
}

bool scr_source_map_is(const ScrDyn *value) {
  return value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_SOURCE_MAP;
}
