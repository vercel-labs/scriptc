/* Intl over ICU4C (packages/runtime/vendor/icu, version-pinned to the ICU
 * Node 24.22.1 bundles). Linked only into programs whose IR selects the
 * `icu` runtime feature, so an Intl-free binary carries none of it.
 *
 * What lowers here:
 *   - Intl.Segmenter({ granularity: "word" })
 *   - Number.prototype.toLocaleString() at the default locale
 *   - Date.prototype.toLocaleString() / toLocaleTimeString() at the default
 *     locale
 *   - Intl.NumberFormat and Intl.DateTimeFormat objects with their options
 *     (read at run time, by ECMA-402's steps) and `format`, and the
 *     toLocaleString / toLocaleDateString / toLocaleTimeString forms with a
 *     locale and options, which construct the same formatters
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
#include <unicode/ucal.h>
#include <unicode/ucurr.h>
#include <unicode/udat.h>
#include <unicode/udatpg.h>
#include <unicode/udata.h>
#include <unicode/uenum.h>
#include <unicode/uloc.h>
#include <unicode/unum.h>
#include <unicode/unumberformatter.h>
#include <unicode/unumsys.h>
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
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
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
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
  }
  return NULL;
}

static ScrDyn *scr_icu_segments_get(void *ptr, const char *key, size_t len) {
  (void)ptr;
  if (len == 10 && memcmp(key, "containing", len) == 0) {
    static const char message[] = "stored Intl.Segmenter methods are not supported yet";
    scr_throw_error_msg_code(SCR_ERR_ERROR, message, sizeof message - 1, "SC2020");
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

/* ── ECMA-402 option bags ─────────────────────────────────────────────
 * Intl.NumberFormat, Intl.DateTimeFormat and the toLocale*String methods
 * read their options object the way ECMA-402 does, at run time: each
 * property once, in the specification's order (a getter or a proxy sees the
 * same reads as in Node), converted and validated with V8's error texts.
 * The options arrive as a checked-dynamic value. */

typedef struct {
  ScrDyn *object;      /* borrowed; NULL: undefined, or a primitive (no such properties) */
  const char *service; /* the constructor or method an out-of-range value names */
} ScrIntlOptions;

/** CoerceOptionsToObject: undefined reads as no options, null throws V8's
 * TypeError naming the method (`method`), and any other primitive is an
 * object with none of the properties. False with the exception pending. */
static bool scr_intl_options(ScrDyn *value, const char *method, ScrIntlOptions *out) {
  out->object = NULL;
  out->service = method;
  if (value == NULL || value->kind == SCR_DYN_UNDEF) return true;
  if (value->kind == SCR_DYN_NULL) {
    ScrJsonBuf message;
    scr_jb_init(&message);
    scr_jb_puts(&message, method);
    scr_jb_puts(&message, " called on null or undefined");
    scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&message));
    return false;
  }
  if (value->kind == SCR_DYN_BOOL || value->kind == SCR_DYN_NUM || value->kind == SCR_DYN_STR ||
      value->kind == SCR_DYN_BIGINT || value->kind == SCR_DYN_SYMBOL)
    return true;
  out->object = value;
  return true;
}

/** Get(options, name): +1, the undefined singleton when there are no
 * options or no such property; NULL with the exception pending. */
static ScrDyn *scr_intl_option(const ScrIntlOptions *options, const char *name) {
  if (options->object == NULL) return scr_dyn_retain(scr_dyn_undefined());
  ScrStr *key = scr_str_new(name, strlen(name));
  ScrDyn *boxed = scr_dyn_new_str(key);
  scr_str_release(key);
  ScrDyn *value = scr_dyn_reflect_get(options->object, boxed, options->object);
  scr_dyn_release(boxed);
  if (value == NULL && !scr_exc_pending()) value = scr_dyn_retain(scr_dyn_undefined());
  return value;
}

/** "Value <value> out of range for <service> options property <name>". */
static void scr_intl_value_out_of_range(const ScrIntlOptions *options, const char *name,
                                        const ScrStr *value) {
  ScrJsonBuf message;
  scr_jb_init(&message);
  scr_jb_puts(&message, "Value ");
  scr_jb_put_str(&message, value);
  scr_jb_puts(&message, " out of range for ");
  scr_jb_puts(&message, options->service);
  scr_jb_puts(&message, " options property ");
  scr_jb_puts(&message, name);
  scr_throw_error(SCR_ERR_RANGE, scr_jb_finish(&message));
}

/** "<name> value is out of range." */
static void scr_intl_property_out_of_range(const char *name) {
  ScrJsonBuf message;
  scr_jb_init(&message);
  scr_jb_puts(&message, name);
  scr_jb_puts(&message, " value is out of range.");
  scr_throw_error(SCR_ERR_RANGE, scr_jb_finish(&message));
}

/** GetOption(options, name, string, values, undefined): 1 with *out the
 * ToString of the value (+1), 0 when the property is undefined (*out NULL),
 * -1 with the exception pending. `allowed` NULL admits every string. */
static int scr_intl_string_option(const ScrIntlOptions *options, const char *name,
                                  const char *const *allowed, size_t count, ScrStr **out) {
  *out = NULL;
  ScrDyn *value = scr_intl_option(options, name);
  if (value == NULL) return -1;
  if (value->kind == SCR_DYN_UNDEF) {
    scr_dyn_release(value);
    return 0;
  }
  ScrStr *text = scr_dyn_string_coerce_js(value);
  scr_dyn_release(value);
  if (text == NULL) return -1;
  if (allowed != NULL) {
    bool found = false;
    for (size_t i = 0; i < count && !found; i++) {
      size_t len = strlen(allowed[i]);
      found = text->len == len && memcmp(text->data, allowed[i], len) == 0;
    }
    if (!found) {
      scr_intl_value_out_of_range(options, name, text);
      scr_str_release(text);
      return -1;
    }
  }
  *out = text;
  return 1;
}

/** scr_intl_string_option for a closed set of values: the index of the
 * value in `allowed`, `fallback` when the property is undefined, -1 with
 * the exception pending. */
static int scr_intl_choice_option(const ScrIntlOptions *options, const char *name,
                                  const char *const *allowed, size_t count, int fallback) {
  ScrStr *text;
  int got = scr_intl_string_option(options, name, allowed, count, &text);
  if (got < 0) return -1;
  if (got == 0) return fallback;
  int index = fallback;
  for (size_t i = 0; i < count; i++) {
    size_t len = strlen(allowed[i]);
    if (text->len == len && memcmp(text->data, allowed[i], len) == 0) index = (int)i;
  }
  scr_str_release(text);
  return index;
}

/** DefaultNumberOption over a value already read: 1 with *out the floor of
 * ToNumber(value), 0 when it is undefined, -1 with the exception pending (a
 * NaN or a value outside [min, max] is V8's RangeError for `name`).
 * Releases `value`. */
static int scr_intl_default_number(ScrDyn *value, const char *name, double min, double max,
                                   double *out) {
  if (value == NULL) return -1;
  if (value->kind == SCR_DYN_UNDEF) {
    scr_dyn_release(value);
    return 0;
  }
  double number;
  bool ok = scr_dyn_number_coerce_js(value, &number);
  scr_dyn_release(value);
  if (!ok) return -1;
  if (isnan(number) || number < min || number > max) {
    scr_intl_property_out_of_range(name);
    return -1;
  }
  *out = floor(number);
  return 1;
}

/** GetNumberOption(options, name, min, max, undefined). */
static int scr_intl_number_option(const ScrIntlOptions *options, const char *name, double min,
                                  double max, double *out) {
  return scr_intl_default_number(scr_intl_option(options, name), name, min, max, out);
}

/** GetOption(options, name, boolean, empty, undefined): 1 with *out
 * ToBoolean(value), 0 when undefined, -1 with the exception pending. */
static int scr_intl_boolean_option(const ScrIntlOptions *options, const char *name, bool *out) {
  ScrDyn *value = scr_intl_option(options, name);
  if (value == NULL) return -1;
  if (value->kind == SCR_DYN_UNDEF) {
    scr_dyn_release(value);
    return 0;
  }
  *out = scr_dyn_truthy(value);
  scr_dyn_release(value);
  return 1;
}

/** A `type` of the Unicode locale extension grammar: (3*8alphanum)
 * *("-" (3*8alphanum)), what a numberingSystem or calendar option must
 * be. */
static bool scr_intl_is_unicode_type(const ScrStr *text) {
  size_t run = 0;
  for (size_t i = 0; i < text->len; i++) {
    unsigned char c = (unsigned char)text->data[i];
    if (c == '-') {
      if (run < 3 || run > 8) return false;
      run = 0;
    } else if ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
      run++;
    } else {
      return false;
    }
  }
  return run >= 3 && run <= 8;
}

/** A feature of the service this runtime does not implement: the coded
 * refusal, never a formatter that answers something else. */
static void scr_intl_refuse(const char *what) {
  ScrJsonBuf message;
  scr_jb_init(&message);
  scr_jb_puts(&message, what);
  scr_jb_puts(&message, " is not supported yet");
  ScrStr *text = scr_jb_finish(&message);
  scr_throw_error_msg_code(SCR_ERR_ERROR, text->data, text->len, "SC2020");
  scr_str_release(text);
}

/** The ICU locale a formatter runs at: the default locale for the empty
 * tag (an absent or undefined locales argument), else the tag's. The
 * compiler passes only tags it accepts. False with the missing-data Error
 * pending. */
static bool scr_intl_locale_of(const ScrStr *tag, char *out, size_t size) {
  if (!scr_intl_data()) {
    scr_intl_no_data();
    return false;
  }
  if (tag == NULL || tag->len == 0) {
    snprintf(out, size, "%s", scr_intl_locale);
    return true;
  }
  char text[ULOC_FULLNAME_CAPACITY];
  if (tag->len >= sizeof text) {
    scr_intl_refuse("this Intl locale");
    return false;
  }
  memcpy(text, tag->data, tag->len);
  text[tag->len] = '\0';
  UErrorCode status = U_ZERO_ERROR;
  uloc_forLanguageTag(text, out, (int32_t)size, NULL, &status);
  if (U_FAILURE(status) || status == U_STRING_NOT_TERMINATED_WARNING) {
    scr_intl_refuse("this Intl locale");
    return false;
  }
  return true;
}

/* ── Intl.NumberFormat ────────────────────────────────────────────────
 * The constructor's options resolve by ECMA-402's steps into the settings
 * V8 hands ICU's number formatter, spelled as a number skeleton (the
 * serialized form of the same settings): the rounding mode first, as V8
 * always sets it, then unit, notation, sign, grouping, integer width and
 * precision. */

typedef struct {
  size_t rc;
  UNumberFormatter *formatter;
} ScrIntlNumberFormat;

static void *scr_intl_number_format_retain(void *ptr) {
  ScrIntlNumberFormat *value = ptr;
  value->rc++;
  return value;
}

static void scr_intl_number_format_release(void *ptr) {
  ScrIntlNumberFormat *value = ptr;
  if (--value->rc) return;
  if (value->formatter != NULL) unumf_close(value->formatter);
  free(value);
}

/* The units ECMA-402 sanctions (IsSanctionedSingleUnitIdentifier), sorted. */
static const char *const SCR_INTL_UNITS[] = {
  "acre",       "bit",        "byte",        "celsius",    "centimeter",        "day",
  "degree",     "fahrenheit", "fluid-ounce", "foot",       "gallon",            "gigabit",
  "gigabyte",   "gram",       "hectare",     "hour",       "inch",              "kilobit",
  "kilobyte",   "kilogram",   "kilometer",   "liter",      "megabit",           "megabyte",
  "meter",      "microsecond", "mile",       "mile-scandinavian", "milliliter", "millimeter",
  "millisecond", "minute",    "month",       "nanosecond", "ounce",             "percent",
  "petabyte",   "pound",      "second",      "stone",      "terabit",           "terabyte",
  "week",       "yard",       "year",
};

static bool scr_intl_is_single_unit(const char *text, size_t len) {
  for (size_t i = 0; i < sizeof SCR_INTL_UNITS / sizeof *SCR_INTL_UNITS; i++) {
    if (strlen(SCR_INTL_UNITS[i]) == len && memcmp(SCR_INTL_UNITS[i], text, len) == 0) return true;
  }
  return false;
}

/** IsWellFormedUnitIdentifier: a sanctioned unit, or two joined by one
 * "-per-". */
static bool scr_intl_is_unit(const ScrStr *unit) {
  if (scr_intl_is_single_unit(unit->data, unit->len)) return true;
  for (size_t at = 0; at + 5 <= unit->len; at++) {
    if (memcmp(unit->data + at, "-per-", 5) != 0) continue;
    if (scr_intl_is_single_unit(unit->data, at) &&
        scr_intl_is_single_unit(unit->data + at + 5, unit->len - at - 5))
      return true;
  }
  return false;
}

/** V8 prints an invalid currency code's or unit's UTF-8 bytes one character
 * each (its message formatter reads them as Latin-1): the same text, so
 * the message is Node's byte for byte. */
static void scr_intl_put_latin1(ScrJsonBuf *message, const ScrStr *text) {
  for (size_t i = 0; i < text->len; i++) {
    unsigned char byte = (unsigned char)text->data[i];
    if (byte < 0x80) {
      scr_jb_write(message, (const char *)&byte, 1);
    } else {
      char pair[2] = { (char)(0xc0 | (byte >> 6)), (char)(0x80 | (byte & 0x3f)) };
      scr_jb_write(message, pair, 2);
    }
  }
}

typedef struct {
  char text[512];
  size_t len;
  bool overflow;
} ScrIntlSkeleton;

static void scr_intl_skeleton_put(ScrIntlSkeleton *skeleton, const char *text) {
  size_t len = strlen(text);
  if (skeleton->len + len + 1 >= sizeof skeleton->text) {
    skeleton->overflow = true;
    return;
  }
  memcpy(skeleton->text + skeleton->len, text, len);
  skeleton->len += len;
  skeleton->text[skeleton->len] = '\0';
}

static void scr_intl_skeleton_repeat(ScrIntlSkeleton *skeleton, char c, int count) {
  char one[2] = { c, '\0' };
  for (int i = 0; i < count; i++) scr_intl_skeleton_put(skeleton, one);
}

/** The digits of a precision: "0"*min then "#"*(max - min). */
static void scr_intl_skeleton_digits(ScrIntlSkeleton *skeleton, char required, int min, int max) {
  scr_intl_skeleton_repeat(skeleton, required, min);
  scr_intl_skeleton_repeat(skeleton, '#', max - min);
}

enum { SCR_NF_DECIMAL, SCR_NF_PERCENT, SCR_NF_CURRENCY, SCR_NF_UNIT };
enum { SCR_NF_STANDARD, SCR_NF_SCIENTIFIC, SCR_NF_ENGINEERING, SCR_NF_COMPACT };
enum { SCR_NF_ROUND_SIGNIFICANT, SCR_NF_ROUND_FRACTION, SCR_NF_ROUND_MORE, SCR_NF_ROUND_LESS };

/** The formatter of `new Intl.NumberFormat(locale, options)`, read from the
 * options in ECMA-402's order. `method` names the caller in error
 * messages: "Intl.NumberFormat", or "Number.prototype.toLocaleString",
 * which constructs the same formatter. NULL with the exception pending. */
static ScrIntlNumberFormat *scr_intl_number_format_resolve(const ScrStr *locale, ScrDyn *optionsValue,
                                                           const char *method) {
  char icuLocale[ULOC_FULLNAME_CAPACITY];
  if (!scr_intl_locale_of(locale, icuLocale, sizeof icuLocale)) return NULL;
  ScrIntlOptions options;
  if (!scr_intl_options(optionsValue, method, &options)) return NULL;

  static const char *const MATCHERS[] = { "lookup", "best fit" };
  if (scr_intl_choice_option(&options, "localeMatcher", MATCHERS, 2, 1) < 0) return NULL;

  /* A numbering system ICU does not have, or an algorithmic one, is
   * ignored, as in V8; a malformed one is the RangeError. */
  char numbering[16] = "";
  {
    ScrStr *text;
    int got = scr_intl_string_option(&options, "numberingSystem", NULL, 0, &text);
    if (got < 0) return NULL;
    if (got > 0) {
      if (!scr_intl_is_unicode_type(text)) {
        ScrJsonBuf message;
        scr_jb_init(&message);
        scr_jb_puts(&message, "Invalid numberingSystem : ");
        scr_jb_put_str(&message, text);
        scr_str_release(text);
        scr_throw_error(SCR_ERR_RANGE, scr_jb_finish(&message));
        return NULL;
      }
      bool named = text->len < sizeof numbering;
      if (named) {
        for (size_t i = 0; i < text->len; i++) {
          char c = text->data[i];
          numbering[i] = (char)(c >= 'A' && c <= 'Z' ? c + 32 : c);
        }
        numbering[text->len] = '\0';
        named = strcmp(numbering, "native") != 0 && strcmp(numbering, "traditio") != 0 &&
                strcmp(numbering, "finance") != 0;
      }
      scr_str_release(text);
      if (named) {
        UErrorCode status = U_ZERO_ERROR;
        UNumberingSystem *system = unumsys_openByName(numbering, &status);
        named = U_SUCCESS(status) && system != NULL && !unumsys_isAlgorithmic(system);
        if (system != NULL) unumsys_close(system);
      }
      if (!named) numbering[0] = '\0';
    }
  }

  static const char *const STYLES[] = { "decimal", "percent", "currency", "unit" };
  int style = scr_intl_choice_option(&options, "style", STYLES, 4, SCR_NF_DECIMAL);
  if (style < 0) return NULL;

  char currency[4] = "";
  {
    ScrStr *text;
    int got = scr_intl_string_option(&options, "currency", NULL, 0, &text);
    if (got < 0) return NULL;
    if (got == 0) {
      if (style == SCR_NF_CURRENCY) {
        static const char message[] = "Currency code is required with currency style.";
        scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
        return NULL;
      }
    } else {
      bool wellFormed = text->len == 3;
      for (size_t i = 0; wellFormed && i < 3; i++) {
        char c = text->data[i];
        wellFormed = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
        currency[i] = (char)(c >= 'a' && c <= 'z' ? c - 32 : c);
      }
      if (!wellFormed) {
        ScrJsonBuf message;
        scr_jb_init(&message);
        scr_jb_puts(&message, "Invalid currency code : ");
        scr_intl_put_latin1(&message, text);
        scr_str_release(text);
        scr_throw_error(SCR_ERR_RANGE, scr_jb_finish(&message));
        return NULL;
      }
      scr_str_release(text);
    }
  }
  static const char *const CURRENCY_DISPLAYS[] = { "code", "symbol", "narrowSymbol", "name" };
  int currencyDisplay = scr_intl_choice_option(&options, "currencyDisplay", CURRENCY_DISPLAYS, 4, 1);
  if (currencyDisplay < 0) return NULL;
  static const char *const CURRENCY_SIGNS[] = { "standard", "accounting" };
  int currencySign = scr_intl_choice_option(&options, "currencySign", CURRENCY_SIGNS, 2, 0);
  if (currencySign < 0) return NULL;

  char unit[64] = "";
  {
    ScrStr *text;
    int got = scr_intl_string_option(&options, "unit", NULL, 0, &text);
    if (got < 0) return NULL;
    bool valid = got == 0 ? style != SCR_NF_UNIT : scr_intl_is_unit(text) && text->len < sizeof unit;
    if (!valid) {
      ScrJsonBuf message;
      scr_jb_init(&message);
      scr_jb_puts(&message, "Invalid unit argument for Intl.NumberFormat() '");
      if (text != NULL) scr_intl_put_latin1(&message, text);
      scr_jb_puts(&message, "'");
      if (text != NULL) scr_str_release(text);
      /* An absent unit under the unit style is V8's TypeError; an unknown
       * unit its RangeError. */
      scr_throw_error(got == 0 ? SCR_ERR_TYPE : SCR_ERR_RANGE, scr_jb_finish(&message));
      return NULL;
    }
    if (text != NULL) {
      memcpy(unit, text->data, text->len);
      unit[text->len] = '\0';
      scr_str_release(text);
    }
  }
  static const char *const UNIT_DISPLAYS[] = { "short", "narrow", "long" };
  int unitDisplay = scr_intl_choice_option(&options, "unitDisplay", UNIT_DISPLAYS, 3, 0);
  if (unitDisplay < 0) return NULL;

  static const char *const NOTATIONS[] = { "standard", "scientific", "engineering", "compact" };
  int notation = scr_intl_choice_option(&options, "notation", NOTATIONS, 4, SCR_NF_STANDARD);
  if (notation < 0) return NULL;

  /* The default fraction digits: a currency's own under the standard
   * notation, else none to three (none for a percentage). */
  int mnfdDefault = 0;
  int mxfdDefault = style == SCR_NF_PERCENT ? 0 : 3;
  if (style == SCR_NF_CURRENCY && notation == SCR_NF_STANDARD) {
    UChar code[4] = { (UChar)currency[0], (UChar)currency[1], (UChar)currency[2], 0 };
    UErrorCode status = U_ZERO_ERROR;
    int32_t digits = ucurr_getDefaultFractionDigits(code, &status);
    if (U_FAILURE(status) || digits < 0) digits = 2;
    mnfdDefault = digits;
    mxfdDefault = digits;
  }

  /* SetNumberFormatDigitOptions. */
  double mnid = 1;
  if (scr_intl_number_option(&options, "minimumIntegerDigits", 1, 21, &mnid) < 0) return NULL;
  ScrDyn *mnfdValue = scr_intl_option(&options, "minimumFractionDigits");
  ScrDyn *mxfdValue = mnfdValue ? scr_intl_option(&options, "maximumFractionDigits") : NULL;
  ScrDyn *mnsdValue = mxfdValue ? scr_intl_option(&options, "minimumSignificantDigits") : NULL;
  ScrDyn *mxsdValue = mnsdValue ? scr_intl_option(&options, "maximumSignificantDigits") : NULL;
  if (mxsdValue == NULL) {
    scr_dyn_release(mnfdValue);
    scr_dyn_release(mxfdValue);
    scr_dyn_release(mnsdValue);
    return NULL;
  }
  bool hasSd = mnsdValue->kind != SCR_DYN_UNDEF || mxsdValue->kind != SCR_DYN_UNDEF;
  bool hasFd = mnfdValue->kind != SCR_DYN_UNDEF || mxfdValue->kind != SCR_DYN_UNDEF;
  /* The remaining reads come first, in the specification's order; the
   * four digit values convert after them. */
  double increment = 1;
  static const char *const ROUNDING_MODES[] = { "ceil",     "floor",     "expand",     "trunc",   "halfCeil",
                                                "halfFloor", "halfExpand", "halfTrunc", "halfEven" };
  static const char *const ROUNDING_PRIORITIES[] = { "auto", "morePrecision", "lessPrecision" };
  static const char *const TRAILING_ZEROS[] = { "auto", "stripIfInteger" };
  int roundingMode = -1;
  int roundingPriority = -1;
  int trailingZero = -1;
  bool read = scr_intl_number_option(&options, "roundingIncrement", 1, 5000, &increment) >= 0;
  if (read) {
    static const int INCREMENTS[] = { 1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000 };
    bool known = false;
    for (size_t i = 0; i < sizeof INCREMENTS / sizeof *INCREMENTS; i++)
      known = known || (double)INCREMENTS[i] == increment;
    if (!known) {
      scr_intl_property_out_of_range("roundingIncrement");
      read = false;
    }
  }
  if (read) {
    roundingMode = scr_intl_choice_option(&options, "roundingMode", ROUNDING_MODES, 9, 6);
    read = roundingMode >= 0;
  }
  if (read) {
    roundingPriority = scr_intl_choice_option(&options, "roundingPriority", ROUNDING_PRIORITIES, 3, 0);
    read = roundingPriority >= 0;
  }
  if (read) {
    trailingZero = scr_intl_choice_option(&options, "trailingZeroDisplay", TRAILING_ZEROS, 2, 0);
    read = trailingZero >= 0;
  }
  if (!read) {
    scr_dyn_release(mnfdValue);
    scr_dyn_release(mxfdValue);
    scr_dyn_release(mnsdValue);
    scr_dyn_release(mxsdValue);
    return NULL;
  }
  bool needSd = true;
  bool needFd = true;
  if (roundingPriority == 0) {
    needSd = hasSd;
    if (needSd || (!hasFd && notation == SCR_NF_COMPACT)) needFd = false;
  }
  double mnsd = 1, mxsd = 21, mnfd = mnfdDefault, mxfd = mxfdDefault;
  bool digitsOk = true;
  if (needSd && hasSd) {
    int got = scr_intl_default_number(mnsdValue, "minimumSignificantDigits", 1, 21, &mnsd);
    mnsdValue = NULL;
    digitsOk = got >= 0;
    if (digitsOk) {
      mxsd = 21;
      got = scr_intl_default_number(mxsdValue, "maximumSignificantDigits", mnsd, 21, &mxsd);
      mxsdValue = NULL;
      digitsOk = got >= 0;
    }
  }
  if (digitsOk && needFd && hasFd) {
    double low = 0, high = 0;
    int gotLow = scr_intl_default_number(mnfdValue, "minimumFractionDigits", 0, 100, &low);
    mnfdValue = NULL;
    digitsOk = gotLow >= 0;
    int gotHigh = 0;
    if (digitsOk) {
      gotHigh = scr_intl_default_number(mxfdValue, "maximumFractionDigits", 0, 100, &high);
      mxfdValue = NULL;
      digitsOk = gotHigh >= 0;
    }
    if (digitsOk) {
      if (gotLow == 0) {
        mxfd = high;
        mnfd = mnfdDefault < high ? mnfdDefault : high;
      } else if (gotHigh == 0) {
        mnfd = low;
        mxfd = mxfdDefault > low ? mxfdDefault : low;
      } else if (low > high) {
        scr_intl_property_out_of_range("maximumFractionDigits");
        digitsOk = false;
      } else {
        mnfd = low;
        mxfd = high;
      }
    }
  }
  scr_dyn_release(mnfdValue);
  scr_dyn_release(mxfdValue);
  scr_dyn_release(mnsdValue);
  scr_dyn_release(mxsdValue);
  if (!digitsOk) return NULL;
  int rounding;
  if (!needSd && !needFd) {
    /* The compact notation's default. */
    mnfd = 0;
    mxfd = 0;
    mnsd = 1;
    mxsd = 2;
    rounding = SCR_NF_ROUND_MORE;
  } else if (roundingPriority == 1) {
    rounding = SCR_NF_ROUND_MORE;
  } else if (roundingPriority == 2) {
    rounding = SCR_NF_ROUND_LESS;
  } else {
    rounding = hasSd ? SCR_NF_ROUND_SIGNIFICANT : SCR_NF_ROUND_FRACTION;
  }
  if (increment != 1) {
    if (rounding != SCR_NF_ROUND_FRACTION) {
      static const char message[] = "RoundingType is not fractionDigits";
      scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
      return NULL;
    }
    if (mxfd != mnfd) {
      scr_intl_property_out_of_range("maximumFractionDigits");
      return NULL;
    }
  }

  static const char *const COMPACT_DISPLAYS[] = { "short", "long" };
  int compactDisplay = scr_intl_choice_option(&options, "compactDisplay", COMPACT_DISPLAYS, 2, 0);
  if (compactDisplay < 0) return NULL;

  /* useGrouping: "auto" (0), "min2" (1), "always" (2), off (3). A boolean
   * true is "always" and any other falsy value is off; the strings "true"
   * and "false" mean the default. */
  int groupingDefault = notation == SCR_NF_COMPACT ? 1 : 0;
  int grouping = groupingDefault;
  {
    ScrDyn *value = scr_intl_option(&options, "useGrouping");
    if (value == NULL) return NULL;
    if (value->kind == SCR_DYN_UNDEF) {
      scr_dyn_release(value);
    } else if (value->kind == SCR_DYN_BOOL && scr_dyn_truthy(value)) {
      scr_dyn_release(value);
      grouping = 2;
    } else if (!scr_dyn_truthy(value)) {
      scr_dyn_release(value);
      grouping = 3;
    } else {
      ScrStr *text = scr_dyn_string_coerce_js(value);
      scr_dyn_release(value);
      if (text == NULL) return NULL;
      static const char *const GROUPINGS[] = { "auto", "min2", "always", "true", "false" };
      int index = -1;
      for (int i = 0; i < 5; i++) {
        size_t len = strlen(GROUPINGS[i]);
        if (text->len == len && memcmp(text->data, GROUPINGS[i], len) == 0) index = i;
      }
      if (index < 0) {
        scr_intl_value_out_of_range(&options, "useGrouping", text);
        scr_str_release(text);
        return NULL;
      }
      scr_str_release(text);
      grouping = index >= 3 ? groupingDefault : index;
    }
  }

  static const char *const SIGN_DISPLAYS[] = { "auto", "never", "always", "exceptZero", "negative" };
  int signDisplay = scr_intl_choice_option(&options, "signDisplay", SIGN_DISPLAYS, 5, 0);
  if (signDisplay < 0) return NULL;

  /* The skeleton. */
  ScrIntlSkeleton skeleton = { .len = 0, .overflow = false };
  static const char *const MODE_STEMS[] = {
    "rounding-mode-ceiling",      "rounding-mode-floor",    "rounding-mode-up",
    "rounding-mode-down",         "rounding-mode-half-ceiling", "rounding-mode-half-floor",
    "rounding-mode-half-up",      "rounding-mode-half-down", "rounding-mode-half-even",
  };
  scr_intl_skeleton_put(&skeleton, MODE_STEMS[roundingMode]);
  if (numbering[0] != '\0') {
    scr_intl_skeleton_put(&skeleton, " numbering-system/");
    scr_intl_skeleton_put(&skeleton, numbering);
  }
  if (style == SCR_NF_PERCENT) {
    scr_intl_skeleton_put(&skeleton, " percent scale/100");
  } else if (style == SCR_NF_CURRENCY) {
    scr_intl_skeleton_put(&skeleton, " currency/");
    scr_intl_skeleton_put(&skeleton, currency);
    if (currencyDisplay == 0) scr_intl_skeleton_put(&skeleton, " unit-width-iso-code");
    if (currencyDisplay == 2) scr_intl_skeleton_put(&skeleton, " unit-width-narrow");
    if (currencyDisplay == 3) scr_intl_skeleton_put(&skeleton, " unit-width-full-name");
  } else if (style == SCR_NF_UNIT) {
    scr_intl_skeleton_put(&skeleton, " unit/");
    scr_intl_skeleton_put(&skeleton, unit);
    if (unitDisplay == 1) scr_intl_skeleton_put(&skeleton, " unit-width-narrow");
    if (unitDisplay == 2) scr_intl_skeleton_put(&skeleton, " unit-width-full-name");
  }
  if (notation == SCR_NF_SCIENTIFIC) scr_intl_skeleton_put(&skeleton, " scientific");
  if (notation == SCR_NF_ENGINEERING) scr_intl_skeleton_put(&skeleton, " engineering");
  if (notation == SCR_NF_COMPACT)
    scr_intl_skeleton_put(&skeleton, compactDisplay == 0 ? " compact-short" : " compact-long");
  {
    /* The accounting sign only applies to the currency style. */
    bool accounting = style == SCR_NF_CURRENCY && currencySign == 1;
    static const char *const STANDARD[] = { NULL, " sign-never", " sign-always", " sign-except-zero",
                                            " sign-negative" };
    static const char *const ACCOUNTING[] = { " sign-accounting", " sign-never", " sign-accounting-always",
                                              " sign-accounting-except-zero", " sign-accounting-negative" };
    const char *stem = accounting ? ACCOUNTING[signDisplay] : STANDARD[signDisplay];
    if (stem != NULL) scr_intl_skeleton_put(&skeleton, stem);
  }
  if (grouping == 1) scr_intl_skeleton_put(&skeleton, " group-min2");
  if (grouping == 2) scr_intl_skeleton_put(&skeleton, " group-on-aligned");
  if (grouping == 3) scr_intl_skeleton_put(&skeleton, " group-off");
  if (mnid > 1) {
    scr_intl_skeleton_put(&skeleton, " integer-width/*");
    scr_intl_skeleton_repeat(&skeleton, '0', (int)mnid);
  }
  scr_intl_skeleton_put(&skeleton, " ");
  if (increment != 1) {
    /* The increment times ten to the minus mxfd, with mxfd fraction digits. */
    char digits[32];
    int len = snprintf(digits, sizeof digits, "%d", (int)increment);
    int fraction = (int)mxfd;
    char value[160];
    int at = 0;
    if (fraction == 0) {
      at = snprintf(value, sizeof value, "%s", digits);
    } else if (len > fraction) {
      at = snprintf(value, sizeof value, "%.*s.%s", len - fraction, digits, digits + len - fraction);
    } else {
      at = snprintf(value, sizeof value, "0.");
      for (int i = 0; i < fraction - len && at < (int)sizeof value - 1; i++) value[at++] = '0';
      at += snprintf(value + at, sizeof value - (size_t)at, "%s", digits);
    }
    (void)at;
    scr_intl_skeleton_put(&skeleton, "precision-increment/");
    scr_intl_skeleton_put(&skeleton, value);
  } else if (rounding == SCR_NF_ROUND_SIGNIFICANT) {
    scr_intl_skeleton_digits(&skeleton, '@', (int)mnsd, (int)mxsd);
  } else {
    scr_intl_skeleton_put(&skeleton, ".");
    scr_intl_skeleton_digits(&skeleton, '0', (int)mnfd, (int)mxfd);
    if (rounding != SCR_NF_ROUND_FRACTION) {
      scr_intl_skeleton_put(&skeleton, "/");
      scr_intl_skeleton_digits(&skeleton, '@', (int)mnsd, (int)mxsd);
      scr_intl_skeleton_put(&skeleton, rounding == SCR_NF_ROUND_MORE ? "r" : "s");
    }
  }
  if (trailingZero == 1) scr_intl_skeleton_put(&skeleton, "/w");

  UChar wide[sizeof skeleton.text];
  int32_t wideLen = skeleton.overflow ? -1 : scr_intl_skeleton(skeleton.text, wide, (int32_t)(sizeof wide / sizeof *wide));
  UErrorCode status = U_ZERO_ERROR;
  UNumberFormatter *formatter =
    wideLen < 0 ? NULL : unumf_openForSkeletonAndLocale(wide, wideLen, icuLocale, &status);
  if (wideLen < 0 || U_FAILURE(status) || formatter == NULL) {
    if (formatter != NULL) unumf_close(formatter);
    scr_intl_refuse("Intl.NumberFormat with this combination of options");
    return NULL;
  }
  ScrIntlNumberFormat *result = calloc(1, sizeof *result);
  if (result == NULL) scr_trap("scriptc: out of memory\n");
  result->rc = 1;
  result->formatter = formatter;
  return result;
}

/** Format one number: +1, or NULL with the exception pending. */
static ScrStr *scr_intl_number_format_run(const ScrIntlNumberFormat *format, double x) {
  UErrorCode status = U_ZERO_ERROR;
  UFormattedNumber *formatted = unumf_openResult(&status);
  if (U_FAILURE(status) || formatted == NULL) {
    scr_intl_no_data();
    return NULL;
  }
  unumf_formatDouble(format->formatter, x, formatted, &status);
  int32_t len = 0;
  const UChar *text = NULL;
  if (U_SUCCESS(status)) {
    const UFormattedValue *value = unumf_resultAsValue(formatted, &status);
    if (U_SUCCESS(status) && value != NULL) text = ufmtval_getString(value, &len, &status);
  }
  ScrStr *result = U_SUCCESS(status) && text != NULL ? scr_intl_from_utf16(text, len) : NULL;
  unumf_closeResult(formatted);
  if (result == NULL) scr_intl_no_data();
  return result;
}

static ScrIntlNumberFormat *scr_intl_number_format_of(ScrDyn *value) {
  if (value != NULL && value->kind == SCR_DYN_HANDLE && value->v.handle.tag == SCR_DYNH_INTL_NUMBER_FORMAT)
    return value->v.handle.ptr;
  static const char message[] =
    "Method Intl.NumberFormat.prototype.format called on incompatible receiver";
  scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
  return NULL;
}

/** `format(value)` over a checked-dynamic value: a number, or undefined
 * (NaN). The mathematical-value inputs (a BigInt, a numeric string, an
 * object) are refused. +1, or NULL with the exception pending. */
static ScrStr *scr_intl_number_format_value(const ScrIntlNumberFormat *format, const ScrDyn *arg) {
  if (arg->kind != SCR_DYN_NUM && arg->kind != SCR_DYN_UNDEF) {
    scr_intl_refuse("Intl.NumberFormat.prototype.format of a value that is not a number");
    return NULL;
  }
  double x = NAN;
  if (arg->kind == SCR_DYN_NUM && !scr_dyn_number_coerce_js(arg, &x)) return NULL;
  return scr_intl_number_format_run(format, x);
}

/** The members a checked-dynamic use of a formatter reaches: `format`; the
 * other methods are refused. */
static ScrDyn *scr_intl_number_format_invoke(void *ptr, ScrDyn *self, const char *method,
                                             ScrDyn *const *args, size_t argc, const char *what) {
  (void)self;
  ScrIntlNumberFormat *format = ptr;
  if (strcmp(method, "format") == 0) {
    ScrStr *text = scr_intl_number_format_value(format, argc ? args[0] : scr_dyn_undefined());
    if (text == NULL) return NULL;
    ScrDyn *boxed = scr_dyn_new_str(text);
    scr_str_release(text);
    return boxed;
  }
  if (strcmp(method, "formatToParts") == 0 || strcmp(method, "formatRange") == 0 ||
      strcmp(method, "formatRangeToParts") == 0 || strcmp(method, "resolvedOptions") == 0) {
    ScrJsonBuf name;
    scr_jb_init(&name);
    scr_jb_puts(&name, "Intl.NumberFormat.prototype.");
    scr_jb_puts(&name, method);
    ScrStr *text = scr_jb_finish(&name);
    char buffer[96];
    snprintf(buffer, sizeof buffer, "%.*s", (int)text->len, text->data);
    scr_str_release(text);
    scr_intl_refuse(buffer);
    return NULL;
  }
  ScrJsonBuf message;
  scr_jb_init(&message);
  scr_jb_puts(&message, what);
  scr_jb_puts(&message, " is not a function");
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&message));
  return NULL;
}

/** A formatter's methods as values (`const f = nf.format`) have no
 * representation: reading one is refused rather than answered undefined. */
static ScrDyn *scr_intl_format_get(void *ptr, const char *key, size_t len) {
  (void)ptr;
  static const char *const METHODS[] = { "format", "formatToParts", "formatRange",
                                         "formatRangeToParts", "resolvedOptions" };
  for (size_t i = 0; i < sizeof METHODS / sizeof *METHODS; i++) {
    if (strlen(METHODS[i]) == len && memcmp(key, METHODS[i], len) == 0) {
      scr_intl_refuse("a stored Intl formatter method");
      return NULL;
    }
  }
  return NULL;
}

static bool scr_intl_format_set(void *ptr, const char *key, size_t len, const ScrDyn *value) {
  (void)ptr;
  (void)key;
  (void)len;
  (void)value;
  return false;
}

static void scr_intl_number_format_ops_install(void) {
  static const ScrDynHandleOps ops = {
    .cls = "NumberFormat",
    .retain = scr_intl_number_format_retain,
    .release = scr_intl_number_format_release,
    .invoke = scr_intl_number_format_invoke,
    .get = scr_intl_format_get,
    .set = scr_intl_format_set,
  };
  scr_dyn_handle_install(SCR_DYNH_INTL_NUMBER_FORMAT, &ops);
}

ScrDyn *scr_intl_number_format_new(ScrStr *locale, ScrDyn *options) {
  ScrIntlNumberFormat *format = scr_intl_number_format_resolve(locale, options, "Intl.NumberFormat");
  if (format == NULL) return NULL;
  scr_intl_number_format_ops_install();
  ScrDyn *boxed = scr_dyn_new_handle(format, SCR_DYNH_INTL_NUMBER_FORMAT);
  scr_intl_number_format_release(format);
  return boxed;
}

ScrStr *scr_intl_number_format_format(ScrDyn *format, double x) {
  ScrIntlNumberFormat *value = scr_intl_number_format_of(format);
  return value == NULL ? NULL : scr_intl_number_format_run(value, x);
}

ScrStr *scr_intl_number_format_format_dyn(ScrDyn *format, ScrDyn *value) {
  ScrIntlNumberFormat *formatter = scr_intl_number_format_of(format);
  return formatter == NULL ? NULL : scr_intl_number_format_value(formatter, value);
}

ScrStr *scr_intl_number_to_locale_string(double x, ScrStr *locale, ScrDyn *options) {
  ScrIntlNumberFormat *format =
    scr_intl_number_format_resolve(locale, options, "Number.prototype.toLocaleString");
  if (format == NULL) return NULL;
  ScrStr *text = scr_intl_number_format_run(format, x);
  scr_intl_number_format_release(format);
  return text;
}

/* ── Intl.DateTimeFormat ──────────────────────────────────────────────
 * The options resolve by ECMA-402's steps into what V8 hands ICU: a
 * skeleton of the requested components (the defaults when none of the
 * required kind is given), the locale's best pattern for it with the hour
 * field's length kept, the hour letters replaced by the resolved hour
 * cycle's, and the time zone. */

typedef struct {
  size_t rc;
  UDateFormat *format;
} ScrIntlDateTimeFormat;

static void *scr_intl_date_time_format_retain(void *ptr) {
  ScrIntlDateTimeFormat *value = ptr;
  value->rc++;
  return value;
}

static void scr_intl_date_time_format_release(void *ptr) {
  ScrIntlDateTimeFormat *value = ptr;
  if (--value->rc) return;
  if (value->format != NULL) udat_close(value->format);
  free(value);
}

static char scr_intl_ascii_upper(char c) {
  return (char)(c >= 'a' && c <= 'z' ? c - 32 : c);
}

static bool scr_intl_ascii_equal_fold(const char *a, size_t alen, const UChar *b, int32_t blen) {
  if ((size_t)blen != alen) return false;
  for (size_t i = 0; i < alen; i++) {
    if (b[i] > 0x7f || scr_intl_ascii_upper(a[i]) != scr_intl_ascii_upper((char)b[i])) return false;
  }
  return true;
}

/** The ICU time zone for a timeZone option: a zone identifier ICU knows,
 * matched without regard to ASCII case (IANA names are case-insensitive),
 * with the UTC names as V8 folds them, or an offset ("+05:30", "-0800",
 * "+03"). False for anything else, which is the RangeError. */
static bool scr_intl_time_zone(const ScrStr *text, UChar *out, int32_t capacity, int32_t *outLen) {
  const char *data = text->data;
  size_t len = text->len;
  static const char *const UTC[] = { "UTC", "GMT", "ETC/UTC", "ETC/GMT" };
  for (size_t i = 0; i < 4; i++) {
    size_t n = strlen(UTC[i]);
    bool same = len == n;
    for (size_t at = 0; same && at < n; at++) same = scr_intl_ascii_upper(data[at]) == UTC[i][at];
    if (same) {
      u_charsToUChars("UTC", out, 4);
      *outLen = 3;
      return true;
    }
  }
  if ((len == 3 || len == 5 || len == 6) && (data[0] == '+' || data[0] == '-')) {
    const char *minutes = len == 6 ? data + 4 : data + 3;
    bool digits = data[1] >= '0' && data[1] <= '9' && data[2] >= '0' && data[2] <= '9' &&
                  (len != 6 || data[3] == ':') &&
                  (len == 3 ||
                   (minutes[0] >= '0' && minutes[0] <= '9' && minutes[1] >= '0' && minutes[1] <= '9'));
    if (digits) {
      int hour = (data[1] - '0') * 10 + (data[2] - '0');
      int minute = len == 3 ? 0 : (minutes[0] - '0') * 10 + (minutes[1] - '0');
      if (hour > 23 || minute > 59) return false;
      char id[16];
      int n = snprintf(id, sizeof id, "GMT%c%02d:%02d", data[0], hour, minute);
      u_charsToUChars(id, out, n + 1);
      *outLen = n;
      return true;
    }
    return false;
  }
  UErrorCode status = U_ZERO_ERROR;
  UEnumeration *zones = ucal_openTimeZones(&status);
  if (U_FAILURE(status) || zones == NULL) return false;
  bool found = false;
  for (;;) {
    int32_t idLen = 0;
    const UChar *id = uenum_unext(zones, &idLen, &status);
    if (U_FAILURE(status) || id == NULL) break;
    if (scr_intl_ascii_equal_fold(data, len, id, idLen) && idLen < capacity) {
      u_memcpy(out, id, idLen);
      out[idLen] = 0;
      *outLen = idLen;
      found = true;
      break;
    }
  }
  uenum_close(zones);
  return found;
}

enum { SCR_HC_H11, SCR_HC_H12, SCR_HC_H23, SCR_HC_H24, SCR_HC_NONE };

/** The pattern with its hour letters replaced by the cycle's, outside
 * quoted text; an hour that follows a day directly gets a space, as in V8.
 * Rewrites `pattern` (capacity `capacity`) and returns its new length. */
static int32_t scr_intl_replace_hour_letters(UChar *pattern, int32_t len, int32_t capacity, int hc) {
  static const UChar LETTER[] = { 'K', 'h', 'H', 'k' };
  UChar replaced[256];
  int32_t at = 0;
  bool quoted = false;
  UChar last = 0;
  for (int32_t i = 0; i < len && at < (int32_t)(sizeof replaced / sizeof *replaced) - 2; i++) {
    UChar c = pattern[i];
    if (c == '\'') {
      quoted = !quoted;
      replaced[at++] = c;
    } else if (c == 'H' || c == 'h' || c == 'K' || c == 'k') {
      if (!quoted && last == 'd') replaced[at++] = ' ';
      replaced[at++] = quoted ? c : LETTER[hc];
    } else {
      replaced[at++] = c;
    }
    last = c;
  }
  if (at > capacity) at = capacity;
  u_memcpy(pattern, replaced, at);
  return at;
}

enum { SCR_DTF_REQUIRE_DATE, SCR_DTF_REQUIRE_TIME, SCR_DTF_REQUIRE_ANY };
enum { SCR_DTF_DEFAULT_DATE, SCR_DTF_DEFAULT_TIME, SCR_DTF_DEFAULT_ALL };

/** One row of the components table: the option, its values, and the
 * skeleton letters of each value. */
typedef struct {
  const char *name;
  const char *const *values;
  const char *const *letters;
  size_t count;
} ScrIntlDateComponent;

/** The formatter of `new Intl.DateTimeFormat(locale, options)`, and of the
 * toLocale*String methods with their required and default components.
 * `method` names the caller in error messages. NULL with the exception
 * pending. */
static ScrIntlDateTimeFormat *scr_intl_date_time_format_resolve(const ScrStr *locale, ScrDyn *optionsValue,
                                                                int required, int defaults,
                                                                const char *method) {
  char icuLocale[ULOC_FULLNAME_CAPACITY];
  if (!scr_intl_locale_of(locale, icuLocale, sizeof icuLocale)) return NULL;
  ScrIntlOptions options;
  if (!scr_intl_options(optionsValue, method, &options)) return NULL;

  static const char *const MATCHERS[] = { "lookup", "best fit" };
  if (scr_intl_choice_option(&options, "localeMatcher", MATCHERS, 2, 1) < 0) return NULL;
  /* A calendar or a numbering system other than the locale's own selects
   * data this formatter does not model: malformed is V8's RangeError,
   * anything else is refused. */
  static const char *const EXTENSIONS[] = { "calendar", "numberingSystem" };
  for (size_t i = 0; i < 2; i++) {
    ScrStr *text;
    int got = scr_intl_string_option(&options, EXTENSIONS[i], NULL, 0, &text);
    if (got < 0) return NULL;
    if (got == 0) continue;
    bool wellFormed = scr_intl_is_unicode_type(text);
    if (!wellFormed) {
      ScrJsonBuf message;
      scr_jb_init(&message);
      scr_jb_puts(&message, "Invalid ");
      scr_jb_puts(&message, EXTENSIONS[i]);
      scr_jb_puts(&message, " : ");
      scr_jb_put_str(&message, text);
      scr_str_release(text);
      scr_throw_error(SCR_ERR_RANGE, scr_jb_finish(&message));
      return NULL;
    }
    scr_str_release(text);
    scr_intl_refuse(i == 0 ? "the Intl.DateTimeFormat option 'calendar'"
                           : "the Intl.DateTimeFormat option 'numberingSystem'");
    return NULL;
  }
  bool hour12 = false;
  int hasHour12 = scr_intl_boolean_option(&options, "hour12", &hour12);
  if (hasHour12 < 0) return NULL;
  static const char *const HOUR_CYCLES[] = { "h11", "h12", "h23", "h24" };
  int hourCycle = scr_intl_choice_option(&options, "hourCycle", HOUR_CYCLES, 4, SCR_HC_NONE);
  if (hourCycle < 0) return NULL;

  /* The zone: the host's when the option is undefined. */
  UChar zone[64];
  int32_t zoneLen = -1;
  {
    ScrStr *text;
    int got = scr_intl_string_option(&options, "timeZone", NULL, 0, &text);
    if (got < 0) return NULL;
    if (got > 0) {
      if (!scr_intl_time_zone(text, zone, (int32_t)(sizeof zone / sizeof *zone), &zoneLen)) {
        ScrJsonBuf message;
        scr_jb_init(&message);
        scr_jb_puts(&message, "Invalid time zone specified: ");
        scr_jb_put_str(&message, text);
        scr_str_release(text);
        scr_throw_error(SCR_ERR_RANGE, scr_jb_finish(&message));
        return NULL;
      }
      scr_str_release(text);
    }
  }

  /* The hour cycle the skeleton's hour letters and the pattern take: the
   * option's, else the locale's; hour12 picks the locale's 12-hour or
   * 24-hour cycle instead. */
  UErrorCode status = U_ZERO_ERROR;
  UDateTimePatternGenerator *generator = udatpg_open(icuLocale, &status);
  if (U_FAILURE(status) || generator == NULL) {
    scr_intl_no_data();
    return NULL;
  }
  int hcDefault = SCR_HC_H23;
  switch (udatpg_getDefaultHourCycle(generator, &status)) {
  case UDAT_HOUR_CYCLE_11: hcDefault = SCR_HC_H11; break;
  case UDAT_HOUR_CYCLE_12: hcDefault = SCR_HC_H12; break;
  case UDAT_HOUR_CYCLE_23: hcDefault = SCR_HC_H23; break;
  case UDAT_HOUR_CYCLE_24: hcDefault = SCR_HC_H24; break;
  }
  if (U_FAILURE(status)) {
    status = U_ZERO_ERROR;
    hcDefault = SCR_HC_H23;
  }
  int hc = hasHour12 > 0 ? SCR_HC_NONE : hourCycle;
  if (hc == SCR_HC_NONE) hc = hcDefault;
  if (hasHour12 > 0) {
    bool japan = strcmp(uloc_getISO3Country(icuLocale), "JPN") == 0;
    if (hour12)
      hc = hcDefault == SCR_HC_H11 || hcDefault == SCR_HC_H12 ? hcDefault : japan ? SCR_HC_H11 : SCR_HC_H12;
    else
      hc = hcDefault == SCR_HC_H23 || hcDefault == SCR_HC_H24 ? hcDefault : SCR_HC_H23;
  }

  static const char *const WIDTHS[] = { "narrow", "long", "short" };
  static const char *const NUMERIC[] = { "2-digit", "numeric" };
  static const char *const MONTHS[] = { "2-digit", "numeric", "narrow", "long", "short" };
  static const char *const ZONE_NAMES[] = { "long",       "short",       "longOffset",
                                            "shortOffset", "longGeneric", "shortGeneric" };
  static const char *const WEEKDAY_LETTERS[] = { "EEEEE", "EEEE", "EEE" };
  static const char *const ERA_LETTERS[] = { "GGGGG", "GGGG", "GGG" };
  static const char *const YEAR_LETTERS[] = { "yy", "y" };
  static const char *const MONTH_LETTERS[] = { "MM", "M", "MMMMM", "MMMM", "MMM" };
  static const char *const DAY_LETTERS[] = { "dd", "d" };
  static const char *const PERIOD_LETTERS[] = { "BBBBB", "BBBB", "B" };
  static const char *const HOUR_LETTERS[4][2] = { { "KK", "K" }, { "hh", "h" }, { "HH", "H" }, { "kk", "k" } };
  static const char *const MINUTE_LETTERS[] = { "mm", "m" };
  static const char *const SECOND_LETTERS[] = { "ss", "s" };
  static const char *const ZONE_LETTERS[] = { "zzzz", "z", "OOOO", "O", "vvvv", "v" };
  const ScrIntlDateComponent components[] = {
    { "weekday", WIDTHS, WEEKDAY_LETTERS, 3 },
    { "era", WIDTHS, ERA_LETTERS, 3 },
    { "year", NUMERIC, YEAR_LETTERS, 2 },
    { "month", MONTHS, MONTH_LETTERS, 5 },
    { "day", NUMERIC, DAY_LETTERS, 2 },
    { "dayPeriod", WIDTHS, PERIOD_LETTERS, 3 },
    { "hour", NUMERIC, HOUR_LETTERS[hc], 2 },
    { "minute", NUMERIC, MINUTE_LETTERS, 2 },
    { "second", NUMERIC, SECOND_LETTERS, 2 },
    { "timeZoneName", ZONE_NAMES, ZONE_LETTERS, 6 },
  };
  char skeleton[96] = "";
  size_t skeletonLen = 0;
  bool anyDate = false; /* weekday, year, month, day */
  bool anyTime = false; /* dayPeriod, hour, minute, second, fractionalSecondDigits */
  bool explicitOption = false;
  bool explicitHour = false;
  for (size_t i = 0; i < sizeof components / sizeof *components; i++) {
    const ScrIntlDateComponent *component = &components[i];
    if (strcmp(component->name, "timeZoneName") == 0) {
      /* fractionalSecondDigits is read before timeZoneName. */
      double digits = 0;
      int got = scr_intl_number_option(&options, "fractionalSecondDigits", 1, 3, &digits);
      if (got < 0) {
        udatpg_close(generator);
        return NULL;
      }
      if (got > 0) {
        for (int d = 0; d < (int)digits; d++) skeleton[skeletonLen++] = 'S';
        skeleton[skeletonLen] = '\0';
        anyTime = true;
        explicitOption = true;
      }
    }
    int choice = scr_intl_choice_option(&options, component->name, component->values, component->count, -1);
    if (choice == -1 && scr_exc_pending()) {
      udatpg_close(generator);
      return NULL;
    }
    if (choice < 0) continue;
    explicitOption = true;
    if (i == 0 || i == 2 || i == 3 || i == 4) anyDate = true;
    if (i >= 5 && i <= 8) anyTime = true;
    if (i == 6) explicitHour = true;
    size_t n = strlen(component->letters[choice]);
    memcpy(skeleton + skeletonLen, component->letters[choice], n + 1);
    skeletonLen += n;
  }
  static const char *const FORMAT_MATCHERS[] = { "basic", "best fit" };
  static const char *const STYLES[] = { "full", "long", "medium", "short" };
  int formatMatcher = scr_intl_choice_option(&options, "formatMatcher", FORMAT_MATCHERS, 2, 1);
  int dateStyle = formatMatcher < 0 ? -2 : scr_intl_choice_option(&options, "dateStyle", STYLES, 4, -1);
  bool failed = formatMatcher < 0 || (dateStyle == -1 && scr_exc_pending()) || dateStyle == -2;
  int timeStyle = failed ? -1 : scr_intl_choice_option(&options, "timeStyle", STYLES, 4, -1);
  failed = failed || (timeStyle == -1 && scr_exc_pending());
  if (failed) {
    udatpg_close(generator);
    return NULL;
  }
  const UChar *zoneId = zoneLen < 0 ? NULL : zone;
  UDateFormat *format = NULL;
  if (dateStyle >= 0 || timeStyle >= 0) {
    /* V8's TypeErrors for a style beside a component, and for a style the
     * method does not format. */
    const char *invalid = explicitOption ? "option"
                          : required == SCR_DTF_REQUIRE_DATE && timeStyle >= 0 ? "timeStyle"
                          : required == SCR_DTF_REQUIRE_TIME && dateStyle >= 0 ? "dateStyle"
                          : NULL;
    if (invalid != NULL) {
      udatpg_close(generator);
      ScrJsonBuf message;
      scr_jb_init(&message);
      scr_jb_puts(&message, "Invalid option : ");
      scr_jb_puts(&message, invalid);
      scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&message));
      return NULL;
    }
    /* The locale's own pattern for the styles. When its hour letters are
     * not the resolved cycle's, the pattern is generated again from its
     * skeleton with the cycle's letter and without the day period, as in
     * V8. */
    static const UDateFormatStyle ICU_STYLES[] = { UDAT_FULL, UDAT_LONG, UDAT_MEDIUM, UDAT_SHORT };
    format = udat_open(timeStyle >= 0 ? ICU_STYLES[timeStyle] : UDAT_NONE,
                       dateStyle >= 0 ? ICU_STYLES[dateStyle] : UDAT_NONE, icuLocale, zoneId, zoneLen, NULL,
                       0, &status);
    if (U_SUCCESS(status) && format != NULL && timeStyle >= 0) {
      UChar pattern[256];
      int32_t patternLen =
        udat_toPattern(format, false, pattern, (int32_t)(sizeof pattern / sizeof *pattern), &status);
      int patternCycle = SCR_HC_NONE;
      bool quoted = false;
      for (int32_t i = 0; U_SUCCESS(status) && i < patternLen && patternCycle == SCR_HC_NONE; i++) {
        UChar c = pattern[i];
        if (c == '\'') quoted = !quoted;
        else if (quoted) continue;
        else if (c == 'K') patternCycle = SCR_HC_H11;
        else if (c == 'h') patternCycle = SCR_HC_H12;
        else if (c == 'H') patternCycle = SCR_HC_H23;
        else if (c == 'k') patternCycle = SCR_HC_H24;
      }
      if (U_SUCCESS(status) && patternCycle != hc) {
        static const UChar LETTER[] = { 'K', 'h', 'H', 'k' };
        UChar skeleton16[128];
        int32_t skeleton16Len = udatpg_getSkeleton(
          generator, pattern, patternLen, skeleton16, (int32_t)(sizeof skeleton16 / sizeof *skeleton16), &status);
        UChar replaced[128];
        int32_t replacedLen = 0;
        for (int32_t i = 0; U_SUCCESS(status) && i < skeleton16Len; i++) {
          UChar c = skeleton16[i];
          if (c == 'a' || c == 'b' || c == 'B') continue;
          replaced[replacedLen++] = c == 'h' || c == 'H' || c == 'K' || c == 'k' ? LETTER[hc] : c;
        }
        UChar best[256];
        int32_t bestLen = U_FAILURE(status)
                            ? -1
                            : udatpg_getBestPatternWithOptions(
                                generator, replaced, replacedLen, UDATPG_MATCH_HOUR_FIELD_LENGTH, best,
                                (int32_t)(sizeof best / sizeof *best) - 32, &status);
        if (U_SUCCESS(status) && bestLen > 0) {
          bestLen = scr_intl_replace_hour_letters(best, bestLen, (int32_t)(sizeof best / sizeof *best), hc);
          udat_close(format);
          format = udat_open(UDAT_PATTERN, UDAT_PATTERN, icuLocale, zoneId, zoneLen, best, bestLen, &status);
        }
      }
    }
    udatpg_close(generator);
  } else {
    /* The defaults, when no component of the required kind was asked for.
     * A default hour takes the 12-hour or the 24-hour letter of the
     * resolved cycle and is not replaced afterwards: the cycle applies to
     * an hour the options ask for. */
    bool needDefaults = true;
    if ((required == SCR_DTF_REQUIRE_DATE || required == SCR_DTF_REQUIRE_ANY) && anyDate) needDefaults = false;
    if ((required == SCR_DTF_REQUIRE_TIME || required == SCR_DTF_REQUIRE_ANY) && anyTime) needDefaults = false;
    if (needDefaults && (defaults == SCR_DTF_DEFAULT_DATE || defaults == SCR_DTF_DEFAULT_ALL)) {
      memcpy(skeleton + skeletonLen, "yMd", 4);
      skeletonLen += 3;
    }
    if (needDefaults && (defaults == SCR_DTF_DEFAULT_TIME || defaults == SCR_DTF_DEFAULT_ALL)) {
      skeleton[skeletonLen++] = hc == SCR_HC_H11 || hc == SCR_HC_H12 ? 'h' : 'H';
      skeleton[skeletonLen++] = 'm';
      skeleton[skeletonLen++] = 's';
      skeleton[skeletonLen] = '\0';
    }
    UChar wide[96];
    int32_t wideLen = scr_intl_skeleton(skeleton, wide, (int32_t)(sizeof wide / sizeof *wide));
    UChar pattern[256];
    int32_t patternLen = wideLen < 0 ? -1
                                     : udatpg_getBestPatternWithOptions(
                                         generator, wide, wideLen, UDATPG_MATCH_HOUR_FIELD_LENGTH, pattern,
                                         (int32_t)(sizeof pattern / sizeof *pattern) - 32, &status);
    udatpg_close(generator);
    if (wideLen < 0 || U_FAILURE(status) || patternLen <= 0) {
      scr_intl_no_data();
      return NULL;
    }
    if (explicitHour)
      patternLen =
        scr_intl_replace_hour_letters(pattern, patternLen, (int32_t)(sizeof pattern / sizeof *pattern), hc);
    format = udat_open(UDAT_PATTERN, UDAT_PATTERN, icuLocale, zoneId, zoneLen, pattern, patternLen, &status);
  }
  if (U_FAILURE(status) || format == NULL) {
    if (format != NULL) udat_close(format);
    scr_intl_no_data();
    return NULL;
  }
  /* ECMAScript time is proleptic Gregorian (see scr_intl_format_date). */
  UErrorCode calendarStatus = U_ZERO_ERROR;
  UCalendar *calendar = ucal_clone(udat_getCalendar(format), &calendarStatus);
  if (U_SUCCESS(calendarStatus) && calendar != NULL) {
    ucal_setGregorianChange(calendar, -9007199254740992.0, &calendarStatus);
    if (U_SUCCESS(calendarStatus)) udat_setCalendar(format, calendar);
    ucal_close(calendar);
  }
  ScrIntlDateTimeFormat *result = calloc(1, sizeof *result);
  if (result == NULL) scr_trap("scriptc: out of memory\n");
  result->rc = 1;
  result->format = format;
  return result;
}

/** Format a time value already known to be a valid date: +1, or NULL with
 * the exception pending. */
static ScrStr *scr_intl_date_time_format_run(const ScrIntlDateTimeFormat *format, double ms) {
  UErrorCode status = U_ZERO_ERROR;
  UChar text[512];
  int32_t len =
    udat_format(format->format, ms, text, (int32_t)(sizeof text / sizeof *text), NULL, &status);
  if (U_FAILURE(status) || len < 0) {
    scr_intl_no_data();
    return NULL;
  }
  scr_intl_undo_narrow_space(text, len);
  return scr_intl_from_utf16(text, len);
}

/** TimeClip: the integral time value, or NaN outside the 8.64e15 ms range. */
static double scr_intl_time_clip(double ms) {
  if (!isfinite(ms) || fabs(ms) > 8.64e15) return NAN;
  return trunc(ms) + 0.0;
}

static ScrStr *scr_intl_date_time_format_value(const ScrIntlDateTimeFormat *format, double ms) {
  double clipped = scr_intl_time_clip(ms);
  if (isnan(clipped)) {
    static const char message[] = "Invalid time value";
    scr_throw_error_msg(SCR_ERR_RANGE, message, sizeof message - 1);
    return NULL;
  }
  return scr_intl_date_time_format_run(format, clipped);
}

/** `format(value)` over a checked-dynamic value: undefined is the current
 * time, a Date its time value, anything else ToNumber. */
static ScrStr *scr_intl_date_time_format_dyn_value(const ScrIntlDateTimeFormat *format, const ScrDyn *arg) {
  double ms;
  if (arg->kind == SCR_DYN_UNDEF) {
    ms = scr_date_now();
  } else if (!scr_dyn_date_class_time(arg, &ms)) {
    if (!scr_dyn_number_coerce_js(arg, &ms)) return NULL;
  }
  return scr_intl_date_time_format_value(format, ms);
}

static ScrDyn *scr_intl_date_time_format_invoke(void *ptr, ScrDyn *self, const char *method,
                                                ScrDyn *const *args, size_t argc, const char *what) {
  (void)self;
  ScrIntlDateTimeFormat *format = ptr;
  if (strcmp(method, "format") == 0) {
    ScrStr *text = scr_intl_date_time_format_dyn_value(format, argc ? args[0] : scr_dyn_undefined());
    if (text == NULL) return NULL;
    ScrDyn *boxed = scr_dyn_new_str(text);
    scr_str_release(text);
    return boxed;
  }
  if (strcmp(method, "formatToParts") == 0 || strcmp(method, "formatRange") == 0 ||
      strcmp(method, "formatRangeToParts") == 0 || strcmp(method, "resolvedOptions") == 0) {
    char buffer[96];
    snprintf(buffer, sizeof buffer, "Intl.DateTimeFormat.prototype.%s", method);
    scr_intl_refuse(buffer);
    return NULL;
  }
  ScrJsonBuf message;
  scr_jb_init(&message);
  scr_jb_puts(&message, what);
  scr_jb_puts(&message, " is not a function");
  scr_throw_error(SCR_ERR_TYPE, scr_jb_finish(&message));
  return NULL;
}

static void scr_intl_date_time_format_ops_install(void) {
  static const ScrDynHandleOps ops = {
    .cls = "DateTimeFormat",
    .retain = scr_intl_date_time_format_retain,
    .release = scr_intl_date_time_format_release,
    .invoke = scr_intl_date_time_format_invoke,
    .get = scr_intl_format_get,
    .set = scr_intl_format_set,
  };
  scr_dyn_handle_install(SCR_DYNH_INTL_DATE_TIME_FORMAT, &ops);
}

ScrDyn *scr_intl_date_time_format_new(ScrStr *locale, ScrDyn *options) {
  ScrIntlDateTimeFormat *format = scr_intl_date_time_format_resolve(
    locale, options, SCR_DTF_REQUIRE_ANY, SCR_DTF_DEFAULT_DATE, "Intl.DateTimeFormat");
  if (format == NULL) return NULL;
  scr_intl_date_time_format_ops_install();
  ScrDyn *boxed = scr_dyn_new_handle(format, SCR_DYNH_INTL_DATE_TIME_FORMAT);
  scr_intl_date_time_format_release(format);
  return boxed;
}

static ScrIntlDateTimeFormat *scr_intl_date_time_format_of(ScrDyn *format) {
  if (format != NULL && format->kind == SCR_DYN_HANDLE &&
      format->v.handle.tag == SCR_DYNH_INTL_DATE_TIME_FORMAT)
    return format->v.handle.ptr;
  static const char message[] =
    "Method Intl.DateTimeFormat.prototype.format called on incompatible receiver";
  scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
  return NULL;
}

ScrStr *scr_intl_date_time_format_format(ScrDyn *format, double ms) {
  ScrIntlDateTimeFormat *formatter = scr_intl_date_time_format_of(format);
  return formatter == NULL ? NULL : scr_intl_date_time_format_value(formatter, ms);
}

ScrStr *scr_intl_date_time_format_format_dyn(ScrDyn *format, ScrDyn *value) {
  ScrIntlDateTimeFormat *formatter = scr_intl_date_time_format_of(format);
  return formatter == NULL ? NULL : scr_intl_date_time_format_dyn_value(formatter, value);
}

ScrStr *scr_intl_date_to_locale(double ms, double kind, ScrStr *locale, ScrDyn *options) {
  /* An invalid date answers the string before any option is read. */
  if (!isfinite(ms)) return scr_str_new("Invalid Date", 12);
  int required = kind == 1 ? SCR_DTF_REQUIRE_DATE : kind == 2 ? SCR_DTF_REQUIRE_TIME : SCR_DTF_REQUIRE_ANY;
  int defaults = kind == 1 ? SCR_DTF_DEFAULT_DATE : kind == 2 ? SCR_DTF_DEFAULT_TIME : SCR_DTF_DEFAULT_ALL;
  const char *method = kind == 1   ? "Date.prototype.toLocaleDateString"
                       : kind == 2 ? "Date.prototype.toLocaleTimeString"
                                   : "Date.prototype.toLocaleString";
  ScrIntlDateTimeFormat *format =
    scr_intl_date_time_format_resolve(locale, options, required, defaults, method);
  if (format == NULL) return NULL;
  ScrStr *text = scr_intl_date_time_format_run(format, ms);
  scr_intl_date_time_format_release(format);
  return text;
}
