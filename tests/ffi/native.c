#ifndef _WIN32
#define _POSIX_C_SOURCE 200809L
#endif

#include <stddef.h>
#include <stdint.h>

#ifdef _WIN32
#include <process.h>
#include <windows.h>
#else
#include <pthread.h>
#include <time.h>
#endif

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
  /* A pumped callback may remove entries mid-pump (sf_retained_remove
   * shifts the array left). Walk a snapshot and fire only entries still
   * registered, so a removal never double-fires the former last entry or
   * invokes a just-released callback. */
  sf_retained_entry snapshot[16];
  size_t count = retained_len;
  for (size_t i = 0; i < count; i++) snapshot[i] = retained_entries[i];
  for (size_t i = 0; i < count; i++) {
    int live = 0;
    for (size_t j = 0; j < retained_len; j++) {
      if (retained_entries[j].callback == snapshot[i].callback &&
          retained_entries[j].context == snapshot[i].context) {
        live = 1;
        break;
      }
    }
    if (live) snapshot[i].callback(value, snapshot[i].context);
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

void sf_retained_raw_set_flush(sf_retained_raw_cb callback) {
  /* Flush-on-replace: fire the OUTGOING callback one last time before
   * storing the new one — the runtime must keep the previous registration
   * live and dispatching until this call returns. */
  if (retained_raw != NULL) retained_raw(-1);
  retained_raw = callback;
}

void sf_retained_raw_remove(sf_retained_raw_cb callback) {
  if (retained_raw == callback) retained_raw = NULL;
}

void sf_retained_raw_pump(double value) {
  if (retained_raw != NULL) retained_raw(value);
}

/* Format-5 foreign-thread callbacks. The first fixture pins wake/FIFO/cstring
 * copying; the second posts concurrently from two library-owned threads and
 * is large enough for the script timer fairness assertion. */
typedef void (*sf_foreign_cb)(double value, const char *label, void *context);
typedef void (*sf_foreign_burst_cb)(double thread_id, double sequence,
                                    void *context);

typedef struct {
  sf_foreign_cb callback;
  void *context;
#ifdef _WIN32
  HANDLE thread;
#else
  pthread_t thread;
#endif
} sf_foreign_state;

static sf_foreign_state foreign_state;

#ifdef _WIN32
static unsigned __stdcall sf_foreign_worker(void *opaque) {
#else
static void *sf_foreign_worker(void *opaque) {
#endif
  sf_foreign_state *state = opaque;
#ifdef _WIN32
  Sleep(20);
#else
  struct timespec delay = {0, 20 * 1000 * 1000};
  (void)nanosleep(&delay, NULL);
#endif
  for (int i = 1; i <= 3; i++) {
    char label[] = "foreign-copy";
    state->callback((double)i, label, state->context);
    label[0] = 'x'; /* queued text must already own its copy */
  }
#ifdef _WIN32
  return 0;
#else
  return NULL;
#endif
}

void sf_foreign_start(sf_foreign_cb callback, void *context) {
  foreign_state.callback = callback;
  foreign_state.context = context;
#ifdef _WIN32
  foreign_state.thread = (HANDLE)_beginthreadex(NULL, 0, sf_foreign_worker,
                                                 &foreign_state, 0, NULL);
#else
  (void)pthread_create(&foreign_state.thread, NULL, sf_foreign_worker,
                       &foreign_state);
#endif
}

void sf_foreign_stop(sf_foreign_cb callback, void *context) {
  (void)callback;
  (void)context;
#ifdef _WIN32
  WaitForSingleObject(foreign_state.thread, INFINITE);
  CloseHandle(foreign_state.thread);
#else
  (void)pthread_join(foreign_state.thread, NULL);
#endif
  foreign_state.callback = NULL;
  foreign_state.context = NULL;
}

typedef struct {
  sf_foreign_burst_cb callback;
  void *context;
  int id;
#ifdef _WIN32
  HANDLE thread;
#else
  pthread_t thread;
#endif
} sf_foreign_burst_state;

static sf_foreign_burst_state foreign_burst[2];

#ifdef _WIN32
static unsigned __stdcall sf_foreign_burst_worker(void *opaque) {
#else
static void *sf_foreign_burst_worker(void *opaque) {
#endif
  sf_foreign_burst_state *state = opaque;
  for (int i = 0; i < 500; i++) {
    state->callback((double)state->id, (double)i, state->context);
  }
#ifdef _WIN32
  return 0;
#else
  return NULL;
#endif
}

void sf_foreign_burst_start(sf_foreign_burst_cb callback, void *context) {
  for (int i = 0; i < 2; i++) {
    foreign_burst[i].callback = callback;
    foreign_burst[i].context = context;
    foreign_burst[i].id = i;
#ifdef _WIN32
    foreign_burst[i].thread = (HANDLE)_beginthreadex(
        NULL, 0, sf_foreign_burst_worker, &foreign_burst[i], 0, NULL);
#else
    (void)pthread_create(&foreign_burst[i].thread, NULL,
                         sf_foreign_burst_worker, &foreign_burst[i]);
#endif
  }
}

void sf_foreign_burst_stop(sf_foreign_burst_cb callback, void *context) {
  (void)callback;
  (void)context;
  for (int i = 0; i < 2; i++) {
#ifdef _WIN32
    WaitForSingleObject(foreign_burst[i].thread, INFINITE);
    CloseHandle(foreign_burst[i].thread);
#else
    (void)pthread_join(foreign_burst[i].thread, NULL);
#endif
    foreign_burst[i].callback = NULL;
    foreign_burst[i].context = NULL;
  }
}
