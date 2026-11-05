/* Intl over ICU4C (packages/runtime/vendor/icu, version-pinned to the ICU
 * Node 24.22.1 bundles). Linked only into programs whose IR selects the
 * `icu` runtime feature, so an Intl-free binary carries none of it.
 *
 * What lowers here (the first slice):
 *   - Intl.Segmenter({ granularity: "word" })
 *   - Number.prototype.toLocaleString() at the default locale
 *   - Date.prototype.toLocaleString() / toLocaleTimeString() at the default
 *     locale
 *
 * The engine-free forms keep their own units: scr_grapheme.c segments
 * default grapheme clusters without ICU, and scr_lib.c formats numbers at
 * the embedded en-US locale.
 *
 * ICU needs its data, 31.6 MiB of icudt78l.dat, which scriptc ships BESIDE
 * the executable rather than inside it: the runtime looks for it in the
 * executable's own directory first, and leaves every other location to
 * ICU's own search (ICU_DATA, the configured default directory). A program
 * built without the data file throws rather than formatting from nothing.
 *
 * Symbols: ICU builds with symbol renaming on (the default), so every ICU
 * entry point carries the version suffix (_78, _u_strFromUTF8_78, ...).
 * That is what lets the zero-cost gate assert that a non-Intl binary links
 * no ICU symbol at all. */
#include "scr_runtime.h"
#include "scr_intl_utf16.h"
#include "scr_number.h"

#include <unicode/ubrk.h>
#include <unicode/udat.h>
#include <unicode/udatpg.h>
#include <unicode/udata.h>
#include <unicode/uloc.h>
#include <unicode/unum.h>
#include <unicode/unumberformatter.h>
#include <unicode/ustring.h>

#include <limits.h>
#include <math.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(__linux__)
#include <unistd.h>
#elif defined(_WIN32)
#include <windows.h>
#endif

/* The data file of the pinned ICU release (vendor-inputs.ts ICU_VERSION). */
#define SCR_INTL_DATA_FILE "icudt78l.dat"

/* ── data ─────────────────────────────────────────────────────────────
 * ICU keeps the mapped data alive for the process lifetime, so the load
 * happens exactly once and never unmaps. Worker threads can make the first
 * ICU call at the same time: pthread_once runs the load on one of them and
 * holds the others until it has finished, so none reads a partial result. */

static pthread_once_t scr_intl_data_once = PTHREAD_ONCE_INIT;
static bool scr_intl_data_ready;

/* The default locale every formatter and the default word segmenter use,
 * resolved with the data (scr_intl_default_locale). */
static char scr_intl_locale[ULOC_FULLNAME_CAPACITY];

/** The running executable's directory, without a trailing separator. */
static bool scr_intl_exe_dir(char *out, size_t size) {
#if defined(__linux__)
  ssize_t got = readlink("/proc/self/exe", out, size - 1);
  if (got <= 0 || (size_t)got >= size - 1) return false;
  out[got] = '\0';
#elif defined(__APPLE__)
  uint32_t rawSize = (uint32_t)size;
  extern int _NSGetExecutablePath(char *buf, uint32_t *bufsize);
  if (_NSGetExecutablePath(out, &rawSize) != 0) return false;
#elif defined(_WIN32)
  DWORD got = GetModuleFileNameA(NULL, out, (DWORD)size - 1);
  if (got == 0 || got >= size - 1) return false;
  out[got] = '\0';
#else
  (void)out;
  (void)size;
  return false;
#endif
  char *slash = strrchr(out, '/');
#if defined(_WIN32)
  char *backslash = strrchr(out, '\\');
  if (backslash != NULL && (slash == NULL || backslash > slash)) slash = backslash;
#endif
  if (slash == NULL) return false;
  *slash = '\0';
  return out[0] != '\0';
}

static bool scr_intl_file_exists(const char *path) {
  FILE *file = fopen(path, "rb");
  if (file == NULL) return false;
  fclose(file);
  return true;
}

/** V8's default locale (Intl::DefaultLocale): ICU's default, which ICU
 * derives from the host environment, as a BCP 47 tag. ICU answers
 * "en_US_POSIX" for LC_ALL=C, C.UTF-8 and POSIX, and V8 replaces that
 * locale (and "c") with "en-US", so the POSIX tailoring's ungrouped
 * numbers never reach a formatter. Every other default round-trips through
 * its language tag, as V8's formatters receive it. */
static void scr_intl_default_locale(void) {
  const char *name = uloc_getDefault();
  if (strcmp(name, "en_US_POSIX") == 0 || strcmp(name, "c") == 0) {
    strcpy(scr_intl_locale, "en_US");
    return;
  }
  char tag[ULOC_FULLNAME_CAPACITY];
  UErrorCode status = U_ZERO_ERROR;
  int32_t tagLen = uloc_toLanguageTag(name, tag, (int32_t)sizeof tag, false, &status);
  if (U_SUCCESS(status) && tagLen > 0 && tagLen < (int32_t)sizeof tag) {
    uloc_forLanguageTag(tag, scr_intl_locale, (int32_t)sizeof scr_intl_locale, NULL, &status);
    if (U_SUCCESS(status) && status != U_STRING_NOT_TERMINATED_WARNING) return;
  }
  snprintf(scr_intl_locale, sizeof scr_intl_locale, "%s", name);
}

/** Points ICU at its data (the file beside the executable, else whatever
 * ICU's own search finds, ICU_DATA), probes it and resolves the default
 * locale. Runs once per process (scr_intl_data). */
static void scr_intl_data_load(void) {
  char dir[PATH_MAX];
  if (scr_intl_exe_dir(dir, sizeof dir)) {
    char path[PATH_MAX];
    if (snprintf(path, sizeof path, "%s/%s", dir, SCR_INTL_DATA_FILE) < (int)sizeof path &&
        scr_intl_file_exists(path)) {
      /* ICU opens <dir>/icudt78l.dat itself from here on. */
      u_setDataDirectory(dir);
    }
  }
  /* Probe one ordinary resource: the default locale's decimal format.
   * Everything else this unit formats resolves through the same data. */
  UErrorCode status = U_ZERO_ERROR;
  UNumberFormat *probe = unum_open(UNUM_DECIMAL, NULL, 0, NULL, NULL, &status);
  if (U_FAILURE(status) || probe == NULL) return;
  unum_close(probe);
  scr_intl_default_locale();
  scr_intl_data_ready = true;
}

/** True once ICU can resolve data. Never throws; the callers do, with the
 * same message. */
static bool scr_intl_data(void) {
  (void)pthread_once(&scr_intl_data_once, scr_intl_data_load);
  return scr_intl_data_ready;
}

/** Throw the missing-data Error (Node cannot reach this: its ICU data is
 * inside the binary). Callers return NULL with the exception pending. */
static void scr_intl_no_data(void) {
  static const char message[] =
    "scriptc: ICU data (icudt78l.dat) was not found next to the executable; this program uses "
    "Intl, so ship the runtime pack's icudt78l.dat beside the binary or point ICU_DATA at it";
  scr_throw_error_msg(SCR_ERR_ERROR, message, sizeof message - 1);
}

/* ── WTF-8 ↔ UTF-16 ───────────────────────────────────────────────────
 * ScrStr storage is canonical WTF-8 (a lone surrogate is its 3-byte
 * generalized form), so both directions preserve lone surrogates and
 * every public offset stays a UTF-16 unit count. Bytes that are not WTF-8
 * decode to U+FFFD (scr_intl_utf16.h), so the UTF-16 copy holds exactly the
 * units it reports. */

/** A UTF-16 copy of `s`, NUL-terminated; *units receives the number of
 * units written. Never NULL for a successful call (an empty string
 * allocates one unit). */
static UChar *scr_intl_to_utf16(const ScrStr *s, int32_t *units) {
  const unsigned char *data = (const unsigned char *)s->data;
  size_t count = scr_intl_utf16_units(data, s->len);
  if (count > INT32_MAX - 1) scr_trap("scriptc: string too long for Intl\n");
  UChar *text = malloc((count + 1) * sizeof *text);
  if (text == NULL) scr_trap("scriptc: out of memory\n");
  size_t written = scr_intl_utf16_fill(data, s->len, (uint16_t *)text);
  text[written] = 0;
  *units = (int32_t)written;
  return text;
}

/** A ScrStr (+1) holding the WTF-8 of `count` UTF-16 units, canonical:
 * an adjacent high/low pair fuses into its 4-byte form. */
static ScrStr *scr_intl_from_utf16(const UChar *text, int32_t count) {
  size_t capacity = ((size_t)count + 1) * 3;
  char *bytes = malloc(capacity);
  if (bytes == NULL) scr_trap("scriptc: out of memory\n");
  size_t len = 0;
  for (int32_t at = 0; at < count; at++) {
    uint32_t cp = text[at];
    if (cp >= 0xd800 && cp <= 0xdbff && at + 1 < count && text[at + 1] >= 0xdc00 &&
        text[at + 1] <= 0xdfff) {
      cp = 0x10000 + ((cp - 0xd800) << 10) + ((uint32_t)text[at + 1] - 0xdc00);
      at++;
    }
    len += scr_wtf8_put(bytes + len, cp);
  }
  ScrStr *result = scr_str_new(bytes, len);
  free(bytes);
  return result;
}

/* ── numbers ──────────────────────────────────────────────────────────── */

/** "rounding-mode-half-up .###" — V8's default number format: CLDR's
 * pattern for the locale (its group sizes and minimumGroupingDigits), at
 * most three fraction digits, half-up rounding. Skeleton text is ASCII. */
static const char SCR_INTL_NUMBER_SKELETON[] = "rounding-mode-half-up .###";

static int32_t scr_intl_skeleton(const char *utf8, UChar *out, int32_t capacity) {
  UErrorCode status = U_ZERO_ERROR;
  int32_t len = 0;
  u_strFromUTF8(out, capacity, &len, utf8, -1, &status);
  return U_FAILURE(status) ? -1 : len;
}

ScrStr *scr_intl_num_format_default(double x) {
  if (!scr_intl_data()) {
    scr_intl_no_data();
    return NULL;
  }
  UErrorCode status = U_ZERO_ERROR;
  UChar skeleton[64];
  int32_t skeletonLen =
    scr_intl_skeleton(SCR_INTL_NUMBER_SKELETON, skeleton, (int32_t)(sizeof skeleton / sizeof *skeleton));
  if (skeletonLen < 0) {
    scr_intl_no_data();
    return NULL;
  }
  UNumberFormatter *formatter =
    unumf_openForSkeletonAndLocale(skeleton, skeletonLen, scr_intl_locale, &status);
  if (U_FAILURE(status) || formatter == NULL) {
    scr_intl_no_data();
    return NULL;
  }
  UFormattedNumber *formatted = unumf_openResult(&status);
  if (U_FAILURE(status) || formatted == NULL) {
    unumf_close(formatter);
    scr_intl_no_data();
    return NULL;
  }
  unumf_formatDouble(formatter, x, formatted, &status);
  int32_t len = 0;
  const UChar *text = NULL;
  if (U_SUCCESS(status)) {
    const UFormattedValue *value = unumf_resultAsValue(formatted, &status);
    if (U_SUCCESS(status) && value != NULL) text = ufmtval_getString(value, &len, &status);
  }
  ScrStr *result = NULL;
  if (U_SUCCESS(status) && text != NULL) result = scr_intl_from_utf16(text, len);
  unumf_closeResult(formatted);
  unumf_close(formatter);
  if (result == NULL) scr_intl_no_data();
  return result;
}

/* ── capability ───────────────────────────────────────────────────────── */

double scr_intl_i18n_support(void) {
  /* Node's process.config.variables.v8_enable_i18n_support is the number 1;
   * so is this binary's, because this unit (and the ICU archive behind it)
   * is what answers the read. Nothing here consults ICU itself: the value
   * describes the build, not the data file a run happens to find. */
  return 1.0;
}

/* ── dates ────────────────────────────────────────────────────────────── */

/** V8's FormatDateTime replaces U+202F NARROW NO-BREAK SPACE with an
 * ordinary space before AM/PM ("Revert ICU 72 change, Part II —
 * crbug.com/1414292"), so ICU versions past 72 keep printing what Node
 * prints. Applied to the UTF-16 result before the WTF-8 conversion. */
static void scr_intl_undo_narrow_space(UChar *text, int32_t len) {
  for (int32_t at = 0; at < len; at++) {
    if (text[at] == 0x202f) text[at] = 0x20;
  }
}

static ScrStr *scr_intl_format_date(double ms, const char *skeletonText) {
  /* TimeClip's invalid date: Node's formatters answer the string rather
   * than throwing. */
  if (!isfinite(ms)) return scr_str_new("Invalid Date", 12);
  if (!scr_intl_data()) {
    scr_intl_no_data();
    return NULL;
  }
  UErrorCode status = U_ZERO_ERROR;
  UChar skeleton[32];
  int32_t skeletonLen =
    scr_intl_skeleton(skeletonText, skeleton, (int32_t)(sizeof skeleton / sizeof *skeleton));
  if (skeletonLen < 0) {
    scr_intl_no_data();
    return NULL;
  }
  UDateTimePatternGenerator *generator = udatpg_open(scr_intl_locale, &status);
  if (U_FAILURE(status) || generator == NULL) {
    scr_intl_no_data();
    return NULL;
  }
  UChar pattern[128];
  int32_t patternLen = udatpg_getBestPattern(
    generator, skeleton, skeletonLen, pattern, (int32_t)(sizeof pattern / sizeof *pattern), &status);
  udatpg_close(generator);
  if (U_FAILURE(status) || patternLen <= 0) {
    scr_intl_no_data();
    return NULL;
  }
  /* A NULL time zone is ICU's default zone, which is the host's (TZ, else
   * /etc/localtime) — the same zone V8's default formatter uses. */
  UDateFormat *format =
    udat_open(UDAT_PATTERN, UDAT_PATTERN, scr_intl_locale, NULL, 0, pattern, patternLen, &status);
  if (U_FAILURE(status) || format == NULL) {
    scr_intl_no_data();
    return NULL;
  }
  /* ECMAScript time is proleptic Gregorian: V8 moves a Gregorian
   * calendar's Julian cutover to the start of ECMAScript time, -2^53 ms
   * (JSDateTimeFormat), so dates before October 1582 keep their Gregorian
   * fields. A non-Gregorian calendar answers U_UNSUPPORTED_ERROR and keeps
   * its own rules, as in V8. */
  UErrorCode calendarStatus = U_ZERO_ERROR;
  UCalendar *calendar = ucal_clone(udat_getCalendar(format), &calendarStatus);
  if (U_SUCCESS(calendarStatus) && calendar != NULL) {
    ucal_setGregorianChange(calendar, -9007199254740992.0, &calendarStatus);
    if (U_SUCCESS(calendarStatus)) udat_setCalendar(format, calendar);
    ucal_close(calendar);
  }
  UChar text[256];
  int32_t len = udat_format(format, ms, text, (int32_t)(sizeof text / sizeof *text), NULL, &status);
  udat_close(format);
  if (U_FAILURE(status) || len < 0) {
    scr_intl_no_data();
    return NULL;
  }
  scr_intl_undo_narrow_space(text, len);
  return scr_intl_from_utf16(text, len);
}

ScrStr *scr_intl_date_locale_string(double ms) {
  return scr_intl_format_date(ms, "yMdjms");
}

ScrStr *scr_intl_date_locale_time_string(double ms) {
  return scr_intl_format_date(ms, "jms");
}

/* ── Intl.Segmenter({ granularity: "word" }) ──────────────────────────── */

typedef struct {
  size_t rc;
  char *locale; /* NULL: the default locale */
} ScrIcuWordSegmenter;

static void *scr_icu_word_segmenter_retain(void *ptr) {
  ScrIcuWordSegmenter *value = ptr;
  value->rc++;
  return value;
}

static void scr_icu_word_segmenter_release(void *ptr) {
  ScrIcuWordSegmenter *value = ptr;
  if (--value->rc) return;
  free(value->locale);
  free(value);
}

typedef struct {
  size_t rc;
  ScrStr *input; /* retained */
  UChar *text;   /* UTF-16 mirror of input, NUL-terminated */
  int32_t units;
  char *locale;
} ScrIcuWordSegments;

static void *scr_icu_word_segments_retain(void *ptr) {
  ScrIcuWordSegments *value = ptr;
  value->rc++;
  return value;
}

static void scr_icu_word_segments_release(void *ptr) {
  ScrIcuWordSegments *value = ptr;
  if (--value->rc) return;
  scr_str_release(value->input);
  free(value->text);
  free(value->locale);
  free(value);
}

static UBreakIterator *scr_icu_word_iterator(const ScrIcuWordSegments *segments) {
  /* A word segmenter need not have formatted anything yet: this iterator
   * can be the program's FIRST ICU use, so the data directory must be
   * resolved here too, before ubrk_open reads its break rules. */
  if (!scr_intl_data()) {
    scr_intl_no_data();
    return NULL;
  }
  UErrorCode status = U_ZERO_ERROR;
  const char *locale = segments->locale != NULL ? segments->locale : scr_intl_locale;
  UBreakIterator *iter = ubrk_open(UBRK_WORD, locale, segments->text, segments->units, &status);
  if (U_FAILURE(status) || iter == NULL) {
    scr_intl_no_data();
    return NULL;
  }
  return iter;
}

/* One segment record: { segment, index, input, isWordLike }. Node's own
 * property order (CreateSegmentDataObject creates them in this order), and
 * isWordLike only for word granularity. */
static ScrDyn *scr_icu_word_record(
  const ScrIcuWordSegments *segments, int32_t start, int32_t end, bool wordLike) {
  ScrDyn *record = scr_dyn_new_obj();
  ScrStr *segment = scr_intl_from_utf16(segments->text + start, end - start);
  scr_dyn_obj_set(record, "segment", 7, scr_dyn_new_str(segment));
  scr_str_release(segment);
  scr_dyn_obj_set(record, "index", 5, scr_dyn_new_num((double)start));
  scr_dyn_obj_set(record, "input", 5, scr_dyn_new_str(segments->input));
  scr_dyn_obj_set(record, "isWordLike", 10, scr_dyn_new_bool(wordLike));
  return record;
}

static ScrDyn *scr_icu_word_iter_pack(void *ptr) {
  ScrIcuWordSegments *segments = ptr;
  ScrDyn *result = scr_dyn_new_arr();
  UBreakIterator *iter = scr_icu_word_iterator(segments);
  if (iter == NULL) {
    scr_dyn_release(result);
    return NULL;
  }
  int32_t start = ubrk_first(iter);
  for (int32_t end = start < 0 ? -1 : ubrk_next(iter); start >= 0 && end >= 0;
       start = end, end = ubrk_next(iter)) {
    bool wordLike = ubrk_getRuleStatus(iter) != UBRK_WORD_NONE;
    scr_dyn_arr_push(result, scr_icu_word_record(segments, start, end, wordLike));
  }
  ubrk_close(iter);
  return result;
}

static ScrDyn *scr_icu_word_box_segments(ScrStr *input, const char *locale);

static ScrDyn *scr_icu_word_segments_containing(ScrIcuWordSegments *segments, double index) {
  index = isnan(index) ? 0 : trunc(index);
  if (!(index >= 0) || !isfinite(index) || index >= (double)segments->units)
    return scr_dyn_retain(scr_dyn_undefined());
  UBreakIterator *iter = scr_icu_word_iterator(segments);
  if (iter == NULL) return NULL;
  int32_t start = ubrk_first(iter);
  ScrDyn *record = NULL;
  for (int32_t end = start < 0 ? -1 : ubrk_next(iter); start >= 0 && end >= 0;
       start = end, end = ubrk_next(iter)) {
    if (index < (double)end) {
      bool wordLike = ubrk_getRuleStatus(iter) != UBRK_WORD_NONE;
      record = scr_icu_word_record(segments, start, end, wordLike);
      break;
    }
  }
  ubrk_close(iter);
  return record != NULL ? record : scr_dyn_retain(scr_dyn_undefined());
}

static ScrDyn *scr_icu_word_segmenter_invoke(void *ptr, ScrDyn *self, const char *method,
    ScrDyn *const *args, size_t argc, const char *what) {
  (void)self;
  ScrIcuWordSegmenter *value = ptr;
  if (strcmp(method, "segment") == 0) {
    ScrStr *input = scr_dyn_string_coerce_js(argc ? args[0] : scr_dyn_undefined());
    if (input == NULL) return NULL;
    ScrDyn *boxed = scr_icu_word_box_segments(input, value->locale);
    scr_str_release(input);
    return boxed;
  }
  if (strcmp(method, "resolvedOptions") == 0) {
    static const char message[] = "Intl.Segmenter locale negotiation is not supported yet";
    scr_throw_error_msg(SCR_ERR_ERROR, message, sizeof message - 1);
    return NULL;
  }
  ScrJsonBuf message;
  scr_jb_init(&message);
  scr_jb_puts(&message, what);
  scr_jb_puts(&message, " is not a function");
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&message));
  return NULL;
}

static ScrDyn *scr_icu_word_segments_invoke(void *ptr, ScrDyn *self, const char *method,
    ScrDyn *const *args, size_t argc, const char *what) {
  (void)self;
  ScrIcuWordSegments *value = ptr;
  if (strcmp(method, "containing") == 0) {
    double index;
    if (!scr_dyn_number_coerce_js(argc ? args[0] : scr_dyn_undefined(), &index)) return NULL;
    return scr_icu_word_segments_containing(value, index);
  }
  ScrJsonBuf message;
  scr_jb_init(&message);
  scr_jb_puts(&message, what);
  scr_jb_puts(&message, " is not a function");
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&message));
  return NULL;
}

static ScrDyn *scr_icu_segmenter_get(void *ptr, const char *key, size_t len) {
  (void)ptr;
  /* The same stance as the grapheme segmenter (scr_grapheme.c): a stored
   * method has no representation, so reading one throws rather than
   * yielding undefined. Only the segmenter's own methods: a Segments
   * object answers the read as an ordinary missing property would. */
  if ((len == 7 && memcmp(key, "segment", len) == 0) ||
      (len == 15 && memcmp(key, "resolvedOptions", len) == 0)) {
    static const char message[] = "stored Intl.Segmenter methods are not supported yet";
    scr_throw_error_msg(SCR_ERR_ERROR, message, sizeof message - 1);
  }
  return NULL;
}

static ScrDyn *scr_icu_segments_get(void *ptr, const char *key, size_t len) {
  (void)ptr;
  if (len == 10 && memcmp(key, "containing", len) == 0) {
    static const char message[] = "stored Intl.Segmenter methods are not supported yet";
    scr_throw_error_msg(SCR_ERR_ERROR, message, sizeof message - 1);
  }
  return NULL;
}

static bool scr_icu_segmenter_set(void *ptr, const char *key, size_t len, const ScrDyn *value) {
  (void)ptr;
  (void)key;
  (void)len;
  (void)value;
  return false;
}

static void scr_icu_word_segmenter_ops_install(void) {
  static const ScrDynHandleOps segmenter = {
    .cls = "Segmenter",
    .retain = scr_icu_word_segmenter_retain,
    .release = scr_icu_word_segmenter_release,
    .invoke = scr_icu_word_segmenter_invoke,
    .get = scr_icu_segmenter_get,
    .set = scr_icu_segmenter_set,
  };
  static const ScrDynHandleOps segments = {
    .cls = "Segments",
    .retain = scr_icu_word_segments_retain,
    .release = scr_icu_word_segments_release,
    .invoke = scr_icu_word_segments_invoke,
    .get = scr_icu_segments_get,
    .set = scr_icu_segmenter_set,
    .iter_pack = scr_icu_word_iter_pack,
  };
  scr_dyn_handle_install(SCR_DYNH_SEGMENTER_WORD, &segmenter);
  scr_dyn_handle_install(SCR_DYNH_SEGMENTS_WORD, &segments);
}

static ScrDyn *scr_icu_word_box_segments(ScrStr *input, const char *locale) {
  ScrIcuWordSegments *value = calloc(1, sizeof *value);
  if (value == NULL) scr_trap("scriptc: out of memory\n");
  value->rc = 1;
  value->input = scr_str_retain(input);
  value->text = scr_intl_to_utf16(input, &value->units);
  if (locale != NULL) {
    size_t len = strlen(locale);
    value->locale = malloc(len + 1);
    if (value->locale == NULL) scr_trap("scriptc: out of memory\n");
    memcpy(value->locale, locale, len + 1);
  }
  ScrDyn *boxed = scr_dyn_new_handle(value, SCR_DYNH_SEGMENTS_WORD);
  scr_icu_word_segments_release(value);
  return boxed;
}

ScrDyn *scr_intl_segmenter_word_new(ScrStr *locale) {
  scr_icu_word_segmenter_ops_install();
  ScrIcuWordSegmenter *value = calloc(1, sizeof *value);
  if (value == NULL) scr_trap("scriptc: out of memory\n");
  value->rc = 1;
  /* The empty tag is the absent locale: NULL selects the default locale
   * (scr_intl_default_locale), which is what V8 negotiates too, while an
   * empty locale name would select root. */
  if (locale != NULL && locale->len > 0) {
    size_t len = locale->len;
    value->locale = malloc(len + 1);
    if (value->locale == NULL) scr_trap("scriptc: out of memory\n");
    memcpy(value->locale, locale->data, len);
    value->locale[len] = '\0';
  }
  ScrDyn *boxed = scr_dyn_new_handle(value, SCR_DYNH_SEGMENTER_WORD);
  scr_icu_word_segmenter_release(value);
  return boxed;
}
