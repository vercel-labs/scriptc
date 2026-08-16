#include <stddef.h>
#include <stdint.h>

static double last_note;

double sf_scale(double value) {
  return value * 2.0;
}

uint8_t sf_invert(uint8_t value) {
  return value ? 0 : 1;
}

uint8_t sf_u8(uint8_t value) {
  return value;
}

uint32_t sf_u32(uint32_t value) {
  return value;
}

int32_t sf_i32(int32_t value) {
  return value;
}

double sf_text_sum(const uint8_t *data, size_t len) {
  double sum = 0;
  for (size_t i = 0; i < len; i++) sum += data[i];
  return sum;
}

double sf_bytes_sum(const uint8_t *data, size_t len) {
  double sum = 0;
  for (size_t i = 0; i < len; i++) sum += data[i];
  return sum;
}

void sf_note(double value) {
  last_note = value;
}

double sf_last_note(void) {
  return last_note;
}

typedef double (*sf_apply_cb)(double value, void *context);

double sf_apply(sf_apply_cb callback, double value, void *context) {
  return callback(value, context);
}

typedef double (*sf_raw_cb)(double value);

double sf_combine_raw(sf_raw_cb left, sf_raw_cb right, double value) {
  return left(value) + right(value);
}

/* These valid external names deliberately overlap the emitter's preferred
 * callback-trampoline and raw-callback TLS names. */
double sc_ffi_cb_0(sf_raw_cb callback) {
  return callback(8);
}

double sc_ffi_cb_ctx_2(double value) {
  return value + 1;
}

typedef uint32_t (*sf_mix_cb)(uint8_t truth, uint8_t byte, uint32_t wide,
                              int32_t signed_value, double fraction,
                              void *context);

uint32_t sf_callback_mix(sf_mix_cb callback, void *context) {
  return callback(2, 255, 4000000000u, -7, 0.5, context);
}

typedef void (*sf_each_cb)(double value, void *context);

void sf_each(sf_each_cb callback, void *context) {
  callback(1, context);
  callback(2, context);
  callback(3, context);
}

typedef void (*sf_prop_visit_cb)(void *context, int32_t id,
                                 const char *name);

void sf_prop_visit(sf_prop_visit_cb callback, void *context) {
  char ascii[] = "alpha";
  char utf8[] = "caf\xc3\xa9";
  char invalid[] = {'b', 'a', 'd', ':', (char)0xc3, '(', 0};
  callback(context, 1, ascii);
  callback(context, 2, utf8);
  callback(context, 3, invalid);
  for (size_t i = 0; i + 1 < sizeof ascii; i++) ascii[i] = 'x';
  for (size_t i = 0; i + 1 < sizeof utf8; i++) utf8[i] = 'x';
  for (size_t i = 0; i + 1 < sizeof invalid; i++) invalid[i] = 'x';
}

typedef void (*sf_spans_cb)(const uint8_t *text, size_t text_len,
                            const uint8_t *bytes, size_t bytes_len,
                            void *context);

void sf_callback_spans(sf_spans_cb callback, void *context) {
  uint8_t text[] = {'A', 0, 'B', 0xc3, 0xa9};
  uint8_t bytes[] = {0, 255, 1};
  callback(text, sizeof text, bytes, sizeof bytes, context);
  for (size_t i = 0; i < sizeof text; i++) text[i] = 'x';
  for (size_t i = 0; i < sizeof bytes; i++) bytes[i] = 42;
  callback(NULL, 0, NULL, 0, context);
}

typedef void (*sf_cstring_cb)(const char *value, void *context);

void sf_callback_string_throw(sf_cstring_cb callback, void *context) {
  callback("materialized", context);
  /* A pending script exception suppresses this second invocation. */
  callback("skipped", context);
}

void sf_null_cstring(sf_cstring_cb callback, void *context) {
  callback(NULL, context);
}

/* Format-4 retained callbacks. This fixture deliberately stores the exact
 * function/context pair and fires it only from a later pump call. Duplicate
 * registrations are distinct native entries, matching the runtime ledger. */
typedef void (*sf_retained_cb)(double value, void *context);

typedef struct {
  sf_retained_cb callback;
  void *context;
} sf_retained_entry;

static sf_retained_entry retained_entries[16];
static size_t retained_len;

void sf_retained_add(sf_retained_cb callback, void *context) {
  if (retained_len < 16) {
    retained_entries[retained_len++] = (sf_retained_entry){callback, context};
  }
}

void sf_retained_remove(sf_retained_cb callback, void *context) {
  for (size_t i = 0; i < retained_len; i++) {
    if (retained_entries[i].callback != callback ||
        retained_entries[i].context != context) continue;
    retained_len--;
    for (size_t j = i; j < retained_len; j++) {
      retained_entries[j] = retained_entries[j + 1];
    }
    return;
  }
}

void sf_retained_pump(double value) {
  size_t end = retained_len;
  for (size_t i = 0; i < end; i++) {
    retained_entries[i].callback(value, retained_entries[i].context);
  }
}

void sf_retained_fire_first(double value) {
  if (retained_len != 0) {
    retained_entries[0].callback(value, retained_entries[0].context);
  }
}

typedef void (*sf_retained_raw_cb)(double value);
static sf_retained_raw_cb retained_raw;

void sf_retained_raw_set(sf_retained_raw_cb callback) {
  retained_raw = callback;
}

void sf_retained_raw_remove(sf_retained_raw_cb callback) {
  if (retained_raw == callback) retained_raw = NULL;
}

void sf_retained_raw_pump(double value) {
  if (retained_raw != NULL) retained_raw(value);
}
