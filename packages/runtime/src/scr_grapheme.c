/* Native Intl.Segmenter for default extended grapheme clusters, UAX #29.
 * Unicode 17 tables are independent of the host locale and need no engine.
 * Word/sentence segmentation and locale negotiation remain unsupported. */
#include "scr_runtime.h"
#include "scr_grapheme_data.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

static unsigned scr_grapheme_property(uint32_t cp) {
  if (cp >= 0xac00 && cp <= 0xd7a3)
    return (cp - 0xac00) % 28 == 0 ? SCR_GCB_LV : SCR_GCB_LVT;
  size_t lo = 0, hi = sizeof scr_grapheme_ranges / sizeof *scr_grapheme_ranges;
  while (lo < hi) {
    size_t mid = lo + (hi - lo) / 2;
    const ScrGraphemeRange *range = &scr_grapheme_ranges[mid];
    if (cp < range->start) hi = mid;
    else if (cp > range->end) lo = mid + 1;
    else return range->properties;
  }
  return 0;
}

/* ScrStr storage is canonical WTF-8. Public offsets count UTF-16 units. */
static uint32_t scr_grapheme_decode(const char *data, size_t *size) {
  const unsigned char *p = (const unsigned char *)data;
  if (p[0] < 0x80) { *size = 1; return p[0]; }
  if (p[0] < 0xe0) { *size = 2; return ((p[0] & 31u) << 6) | (p[1] & 63u); }
  if (p[0] < 0xf0) {
    *size = 3;
    return ((p[0] & 15u) << 12) | ((p[1] & 63u) << 6) | (p[2] & 63u);
  }
  *size = 4;
  return ((p[0] & 7u) << 18) | ((p[1] & 63u) << 12) | ((p[2] & 63u) << 6) | (p[3] & 63u);
}

static bool scr_grapheme_control(unsigned gcb) {
  return gcb == SCR_GCB_CR || gcb == SCR_GCB_LF || gcb == SCR_GCB_CONTROL;
}

/* One cluster, linear in the bytes visited. Context states encode the
 * look-behind rules GB9c, GB11 and GB12/13 without rescanning the prefix. */
static size_t scr_grapheme_next(const ScrStr *input, size_t start, size_t *units) {
  unsigned previous = SCR_GCB_OTHER;
  bool ep_extend = false, ep_zwj = false;
  unsigned indic = 0, ri_parity = 0;
  size_t at = start;
  *units = 0;
  while (at < input->len) {
    size_t size;
    uint32_t cp = scr_grapheme_decode(input->data + at, &size);
    unsigned property = scr_grapheme_property(cp);
    unsigned current = property & 15u, incb = (property >> 4) & 3u;
    bool pictographic = (property & 64u) != 0;
    if (at != start) {
      bool join;
      if (previous == SCR_GCB_CR && current == SCR_GCB_LF) join = true; /* GB3 */
      else if (scr_grapheme_control(previous) || scr_grapheme_control(current)) join = false; /* GB4/5 */
      else if (previous == SCR_GCB_L && (current == SCR_GCB_L || current == SCR_GCB_V || current == SCR_GCB_LV || current == SCR_GCB_LVT)) join = true; /* GB6 */
      else if ((previous == SCR_GCB_LV || previous == SCR_GCB_V) && (current == SCR_GCB_V || current == SCR_GCB_T)) join = true; /* GB7 */
      else if ((previous == SCR_GCB_LVT || previous == SCR_GCB_T) && current == SCR_GCB_T) join = true; /* GB8 */
      else if (current == SCR_GCB_EXTEND || current == SCR_GCB_ZWJ || current == SCR_GCB_SPACINGMARK) join = true; /* GB9/9a */
      else if (previous == SCR_GCB_PREPEND) join = true; /* GB9b */
      else if (incb == 1 && indic == 2) join = true; /* GB9c: consonant, linker, consonant */
      else if (pictographic && previous == SCR_GCB_ZWJ && ep_zwj) join = true; /* GB11 */
      else join = current == SCR_GCB_REGIONAL_INDICATOR && previous == SCR_GCB_REGIONAL_INDICATOR && ri_parity; /* GB12/13, GB999 */
      if (!join) break;
    }
    ep_zwj = current == SCR_GCB_ZWJ && ep_extend;
    ep_extend = pictographic || (current == SCR_GCB_EXTEND && ep_extend);
    if (incb == 1) indic = 1;
    else if (incb == 3 && indic) indic = 2;
    else if (incb != 2 && incb != 3) indic = 0;
    ri_parity = current == SCR_GCB_REGIONAL_INDICATOR ? ri_parity ^ 1u : 0;
    previous = current;
    *units += cp > 0xffff ? 2 : 1;
    at += size;
  }
  return at;
}

typedef struct {
  size_t rc;
  ScrStr *input; /* NULL for Segmenter, retained text for Segments */
} ScrGraphemes;

static void *scr_graphemes_retain(void *ptr) {
  ScrGraphemes *value = ptr;
  value->rc++;
  return value;
}

static void scr_graphemes_release(void *ptr) {
  ScrGraphemes *value = ptr;
  if (--value->rc) return;
  scr_str_release(value->input);
  free(value);
}

static ScrDyn *scr_graphemes_box(ScrStr *input, ScrDynHandleTag tag) {
  ScrGraphemes *value = calloc(1, sizeof *value);
  if (!value) scr_trap("scriptc: out of memory\n");
  value->rc = 1;
  value->input = input; /* takes ownership */
  ScrDyn *boxed = scr_dyn_new_handle(value, tag);
  scr_graphemes_release(value);
  return boxed;
}

static ScrDyn *scr_grapheme_record(ScrStr *input, size_t start, size_t end, size_t index) {
  ScrDyn *record = scr_dyn_new_obj();
  ScrStr *segment = scr_str_new(input->data + start, end - start);
  scr_dyn_obj_set(record, "segment", 7, scr_dyn_new_str(segment));
  scr_str_release(segment);
  scr_dyn_obj_set(record, "index", 5, scr_dyn_new_num((double)index));
  scr_dyn_obj_set(record, "input", 5, scr_dyn_new_str(input));
  return record;
}

static ScrDyn *scr_graphemes_iter(void *ptr) {
  ScrStr *input = ((ScrGraphemes *)ptr)->input;
  ScrDyn *result = scr_dyn_new_arr();
  size_t index = 0;
  for (size_t start = 0; start < input->len;) {
    size_t units;
    size_t end = scr_grapheme_next(input, start, &units);
    scr_dyn_arr_push(result, scr_grapheme_record(input, start, end, index));
    index += units;
    start = end;
  }
  return result;
}

static ScrDyn *scr_graphemes_invoke(void *ptr, ScrDyn *self, const char *method,
    ScrDyn *const *args, size_t argc, const char *what) {
  (void)self;
  ScrGraphemes *value = ptr;
  ScrDyn *arg = argc ? args[0] : scr_dyn_undefined();
  if (!value->input && strcmp(method, "segment") == 0) {
    ScrStr *input = scr_dyn_string_coerce_js(arg);
    if (!input) return NULL;
    return scr_graphemes_box(input, SCR_DYNH_SEGMENTS);
  }
  if (value->input && strcmp(method, "containing") == 0) {
    double index;
    if (!scr_dyn_number_coerce_js(arg, &index)) return NULL;
    index = isnan(index) ? 0 : trunc(index);
    if (index >= 0 && isfinite(index)) {
      size_t offset = 0;
      for (size_t start = 0; start < value->input->len;) {
        size_t units;
        size_t end = scr_grapheme_next(value->input, start, &units);
        if (index < (double)(offset + units)) return scr_grapheme_record(value->input, start, end, offset);
        offset += units;
        start = end;
      }
    }
    return scr_dyn_retain(scr_dyn_undefined());
  }
  if (!value->input && strcmp(method, "resolvedOptions") == 0) {
    static const char msg[] = "Intl.Segmenter locale negotiation is not supported yet";
    scr_throw_error_msg(SCR_ERR_ERROR, msg, sizeof msg - 1);
    return NULL;
  }
  ScrJsonBuf message;
  scr_jb_init(&message);
  scr_jb_puts(&message, what);
  scr_jb_puts(&message, " is not a function");
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&message));
  return NULL;
}

static ScrDyn *scr_graphemes_get(void *ptr, const char *key, size_t len) {
  ScrGraphemes *value = ptr;
  if ((!value->input && ((len == 7 && memcmp(key, "segment", len) == 0) ||
      (len == 15 && memcmp(key, "resolvedOptions", len) == 0))) ||
      (value->input && len == 10 && memcmp(key, "containing", len) == 0)) {
    static const char msg[] = "stored Intl.Segmenter methods are not supported yet";
    scr_throw_error_msg(SCR_ERR_ERROR, msg, sizeof msg - 1);
  }
  return NULL;
}

static bool scr_graphemes_set(void *ptr, const char *key, size_t len, const ScrDyn *value) {
  (void)ptr; (void)key; (void)len; (void)value;
  return false;
}

ScrDyn *scr_intl_segmenter_new(void) {
  static const ScrDynHandleOps segmenter = {
    .cls = "Segmenter", .retain = scr_graphemes_retain, .release = scr_graphemes_release,
    .invoke = scr_graphemes_invoke, .get = scr_graphemes_get, .set = scr_graphemes_set,
  };
  static const ScrDynHandleOps segments = {
    .cls = "Segments", .retain = scr_graphemes_retain, .release = scr_graphemes_release,
    .invoke = scr_graphemes_invoke, .get = scr_graphemes_get, .set = scr_graphemes_set,
    .iter_pack = scr_graphemes_iter,
  };
  scr_dyn_handle_install(SCR_DYNH_SEGMENTER, &segmenter);
  scr_dyn_handle_install(SCR_DYNH_SEGMENTS, &segments);
  return scr_graphemes_box(NULL, SCR_DYNH_SEGMENTER);
}

/* A word or sentence Segmenter, which JavaScript dependencies may build at
 * module load and use on some paths only: it constructs, and its segment()
 * throws the compiler's SC2020 message. */
typedef struct {
  size_t rc;
  ScrStr *refusal; /* retained */
} ScrRefusingSegmenter;

static void *scr_refusing_segmenter_retain(void *ptr) {
  ScrRefusingSegmenter *value = ptr;
  value->rc++;
  return value;
}

static void scr_refusing_segmenter_release(void *ptr) {
  ScrRefusingSegmenter *value = ptr;
  if (--value->rc) return;
  scr_str_release(value->refusal);
  free(value);
}

static ScrDyn *scr_refusing_segmenter_invoke(void *ptr, ScrDyn *self, const char *method,
    ScrDyn *const *args, size_t argc, const char *what) {
  ScrRefusingSegmenter *value = ptr;
  if (strcmp(method, "segment") == 0) {
    ScrStr *input = scr_dyn_string_coerce_js(argc ? args[0] : scr_dyn_undefined());
    if (!input) return NULL;
    scr_str_release(input);
    scr_throw_error_msg_code(SCR_ERR_ERROR, value->refusal->data, value->refusal->len, "SC2020");
    return NULL;
  }
  return scr_graphemes_invoke(&(ScrGraphemes){ .rc = 1 }, self, method, args, argc, what);
}

static ScrDyn *scr_refusing_segmenter_get(void *ptr, const char *key, size_t len) {
  (void)ptr;
  return scr_graphemes_get(&(ScrGraphemes){ .rc = 1 }, key, len);
}

ScrDyn *scr_intl_segmenter_refusing(ScrStr *refusal) {
  static const ScrDynHandleOps segmenter = {
    .cls = "Segmenter", .retain = scr_refusing_segmenter_retain,
    .release = scr_refusing_segmenter_release, .invoke = scr_refusing_segmenter_invoke,
    .get = scr_refusing_segmenter_get, .set = scr_graphemes_set,
  };
  scr_dyn_handle_install(SCR_DYNH_SEGMENTER_REFUSING, &segmenter);
  ScrRefusingSegmenter *value = calloc(1, sizeof *value);
  if (!value) scr_trap("scriptc: out of memory\n");
  value->rc = 1;
  value->refusal = scr_str_retain(refusal);
  ScrDyn *boxed = scr_dyn_new_handle(value, SCR_DYNH_SEGMENTER_REFUSING);
  scr_refusing_segmenter_release(value);
  return boxed;
}
