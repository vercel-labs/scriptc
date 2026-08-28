#include "scr_runtime.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
#elif defined(__wasi__)
/* Native FFI is rejected for WASI. This keeps direct runtime builds honest. */
#else
#include <fcntl.h>
#include <pthread.h>
#include <unistd.h>
#endif

typedef enum {
  SCR_FFI_ARG_NONE = 0,
  SCR_FFI_ARG_F64,
  SCR_FFI_ARG_BOOL,
  SCR_FFI_ARG_U8,
  SCR_FFI_ARG_U32,
  SCR_FFI_ARG_I32,
  SCR_FFI_ARG_DATA,
} ScrFfiArgKind;

typedef struct {
  ScrFfiArgKind kind;
  union {
    double f64;
    uint32_t u32;
    int32_t i32;
    struct {
      uint8_t *data;
      size_t len;
    } span;
  } value;
} ScrFfiArg;

struct ScrFfiCall {
  ScrFfiTable *table;       /* opaque on the posting thread */
  void *loop;               /* reserved instance/loop identity */
  ScrClosure *callback;     /* opaque; the table owns its script RC pin */
  ScrFfiDispatchFn dispatch;
  size_t nargs;
  ScrFfiArg *args;
  struct ScrFfiCall *next;
};

static ScrFfiCall *scr_ffi_head;
static ScrFfiCall *scr_ffi_tail;
static size_t scr_ffi_foreign_registrations;
static bool scr_ffi_installed;
static bool scr_ffi_stopping;
static int scr_ffi_wake_pipe[2] = {-1, -1};

#ifdef _WIN32
static SRWLOCK scr_ffi_lock = SRWLOCK_INIT;
static void scr_ffi_lock_enter(void) { AcquireSRWLockExclusive(&scr_ffi_lock); }
static void scr_ffi_lock_leave(void) { ReleaseSRWLockExclusive(&scr_ffi_lock); }
#elif defined(__wasi__)
static void scr_ffi_lock_enter(void) {}
static void scr_ffi_lock_leave(void) {}
#else
static pthread_mutex_t scr_ffi_lock = PTHREAD_MUTEX_INITIALIZER;
static void scr_ffi_lock_enter(void) { (void)pthread_mutex_lock(&scr_ffi_lock); }
static void scr_ffi_lock_leave(void) { (void)pthread_mutex_unlock(&scr_ffi_lock); }
#endif

static void scr_ffi_oom(void) { scr_trap("scriptc: out of memory\n"); }

/* Foreign trampolines cannot enter the script exception machinery. Allocation
 * failure and malformed native pointers are fatal process-boundary failures,
 * reported without touching any runtime object. */
static void scr_ffi_foreign_fatal(const char *message) {
  fputs(message, stderr);
  abort();
}

static void *scr_ffi_foreign_alloc(size_t size) {
  void *ptr = malloc(size == 0 ? 1 : size);
  if (ptr == NULL) scr_ffi_foreign_fatal("scriptc: out of memory\n");
  return ptr;
}

static void scr_ffi_call_free(ScrFfiCall *call) {
  if (call == NULL) return;
  for (size_t i = 0; i < call->nargs; i++) {
    if (call->args[i].kind == SCR_FFI_ARG_DATA) free(call->args[i].value.span.data);
  }
  free(call->args);
  free(call);
}

static bool scr_ffi_table_contains(const ScrFfiTable *table, const ScrClosure *callback) {
  for (size_t i = 0; i < table->len; i++) {
    if (table->entries[i] == callback) return true;
  }
  return false;
}

static void scr_ffi_table_retire(ScrFfiTable *table, ScrClosure *callback) {
  if (table->retired_len == table->retired_cap) {
    size_t cap = table->retired_cap == 0 ? 4 : table->retired_cap * 2;
    if (cap < table->retired_cap || cap > SIZE_MAX / sizeof *table->retired) scr_ffi_oom();
    ScrClosure **retired = realloc(table->retired, cap * sizeof *retired);
    if (retired == NULL) scr_ffi_oom();
    table->retired = retired;
    table->retired_cap = cap;
  }
  table->retired[table->retired_len++] = callback;
}

static void scr_ffi_release_retired(ScrFfiTable *table) {
  ScrClosure **retired = NULL;
  size_t len = 0;
  scr_ffi_lock_enter();
  if (table->queued == 0 && table->retired_len > 0) {
    retired = table->retired;
    len = table->retired_len;
    table->retired = NULL;
    table->retired_len = 0;
    table->retired_cap = 0;
  }
  scr_ffi_lock_leave();
  for (size_t i = 0; i < len; i++) scr_closure_release(retired[i]);
  free(retired);
}

void scr_ffi_retain_foreign(ScrFfiTable *table, ScrClosure *callback) {
  table->teardown = &scr_ffi_teardown_foreign;
  scr_ffi_link(table);
  scr_ffi_lock_enter();
  if (table->len == table->cap) {
    size_t cap = table->cap == 0 ? 4 : table->cap * 2;
    if (cap < table->cap || cap > SIZE_MAX / sizeof *table->entries) scr_ffi_oom();
    ScrClosure **entries = realloc(table->entries, cap * sizeof *entries);
    if (entries == NULL) scr_ffi_oom();
    table->entries = entries;
    table->cap = cap;
  }
  table->entries[table->len++] = scr_closure_retain(callback);
  scr_ffi_foreign_registrations++;
  scr_ffi_lock_leave();
}

void scr_ffi_require_foreign(ScrFfiTable *table, ScrClosure *callback) {
  scr_ffi_lock_enter();
  bool found = scr_ffi_table_contains(table, callback);
  scr_ffi_lock_leave();
  if (!found) scr_trap("scriptc: releasing a native callback registration that does not exist\n");
}

void scr_ffi_release_foreign(ScrFfiTable *table, ScrClosure *callback) {
  scr_ffi_lock_enter();
  for (size_t i = 0; i < table->len; i++) {
    if (table->entries[i] != callback) continue;
    ScrClosure *owned = table->entries[i];
    table->len--;
    if (i != table->len) table->entries[i] = table->entries[table->len];
    if (scr_ffi_foreign_registrations > 0) scr_ffi_foreign_registrations--;
    bool deferred = table->queued > 0;
    if (deferred) scr_ffi_table_retire(table, owned);
    scr_ffi_lock_leave();
    if (!deferred) scr_closure_release(owned);
    return;
  }
  scr_ffi_lock_leave();
  scr_trap("scriptc: releasing a native callback registration that does not exist\n");
}

ScrFfiCall *scr_ffi_call_new(ScrFfiTable *table, ScrClosure *callback,
                             ScrFfiDispatchFn dispatch, size_t nargs) {
  ScrFfiCall *call = scr_ffi_foreign_alloc(sizeof *call);
  call->table = table;
  call->loop = table->loop;
  call->callback = callback;
  call->dispatch = dispatch;
  call->nargs = nargs;
  call->args = nargs == 0 ? NULL : scr_ffi_foreign_alloc(nargs * sizeof *call->args);
  if (nargs > 0) memset(call->args, 0, nargs * sizeof *call->args);
  call->next = NULL;
  return call;
}

static ScrFfiArg *scr_ffi_call_arg(ScrFfiCall *call, size_t index) {
  if (index >= call->nargs) scr_ffi_foreign_fatal("scriptc: invalid staged FFI callback argument\n");
  return &call->args[index];
}

void scr_ffi_call_set_f64(ScrFfiCall *call, size_t i, double v) {
  ScrFfiArg *arg = scr_ffi_call_arg(call, i); arg->kind = SCR_FFI_ARG_F64; arg->value.f64 = v;
}
void scr_ffi_call_set_bool(ScrFfiCall *call, size_t i, uint8_t v) {
  ScrFfiArg *arg = scr_ffi_call_arg(call, i); arg->kind = SCR_FFI_ARG_BOOL; arg->value.u32 = v != 0;
}
void scr_ffi_call_set_u8(ScrFfiCall *call, size_t i, uint8_t v) {
  ScrFfiArg *arg = scr_ffi_call_arg(call, i); arg->kind = SCR_FFI_ARG_U8; arg->value.u32 = v;
}
void scr_ffi_call_set_u32(ScrFfiCall *call, size_t i, uint32_t v) {
  ScrFfiArg *arg = scr_ffi_call_arg(call, i); arg->kind = SCR_FFI_ARG_U32; arg->value.u32 = v;
}
void scr_ffi_call_set_i32(ScrFfiCall *call, size_t i, int32_t v) {
  ScrFfiArg *arg = scr_ffi_call_arg(call, i); arg->kind = SCR_FFI_ARG_I32; arg->value.i32 = v;
}

static void scr_ffi_call_copy_data(ScrFfiCall *call, size_t i,
                                   const uint8_t *v, size_t len,
                                   const char *null_message) {
  if (v == NULL && len != 0) scr_ffi_foreign_fatal(null_message);
  ScrFfiArg *arg = scr_ffi_call_arg(call, i);
  arg->kind = SCR_FFI_ARG_DATA;
  arg->value.span.len = len;
  arg->value.span.data = len == 0 ? NULL : scr_ffi_foreign_alloc(len);
  if (len > 0) memcpy(arg->value.span.data, v, len);
}

void scr_ffi_call_copy_string(ScrFfiCall *call, size_t i,
                              const uint8_t *v, size_t len) {
  scr_ffi_call_copy_data(call, i, v, len,
      "scriptc: native callback passed a NULL string span with nonzero length\n");
}

void scr_ffi_call_copy_bytes(ScrFfiCall *call, size_t i,
                             const uint8_t *v, size_t len) {
  scr_ffi_call_copy_data(call, i, v, len,
      "scriptc: native callback passed a NULL bytes span with nonzero length\n");
}

void scr_ffi_call_copy_cstring(ScrFfiCall *call, size_t i, const char *v) {
  if (v == NULL) scr_ffi_foreign_fatal("scriptc: native callback passed a NULL cstring\n");
  scr_ffi_call_copy_data(call, i, (const uint8_t *)v, strlen(v),
                         "scriptc: native callback passed a NULL cstring\n");
}

void scr_ffi_post(ScrFfiCall *call) {
  scr_ffi_lock_enter();
  if (scr_ffi_stopping || !scr_ffi_table_contains(call->table, call->callback)) {
    scr_ffi_lock_leave();
    scr_ffi_call_free(call);
    return;
  }
  call->table->queued++;
  if (scr_ffi_tail != NULL) scr_ffi_tail->next = call;
  else scr_ffi_head = call;
  scr_ffi_tail = call;
#if !defined(_WIN32) && !defined(__wasi__)
  if (scr_ffi_wake_pipe[1] >= 0) {
    ssize_t ignored = write(scr_ffi_wake_pipe[1], "f", 1);
    (void)ignored; /* a full pipe is already readable */
  }
#endif
  scr_ffi_lock_leave();
}

static const ScrFfiArg *scr_ffi_get_arg(const ScrFfiCall *call, size_t index) {
  if (index >= call->nargs) scr_trap("scriptc: invalid staged FFI callback argument\n");
  return &call->args[index];
}

double scr_ffi_call_get_f64(const ScrFfiCall *call, size_t i) { return scr_ffi_get_arg(call, i)->value.f64; }
bool scr_ffi_call_get_bool(const ScrFfiCall *call, size_t i) { return scr_ffi_get_arg(call, i)->value.u32 != 0; }
double scr_ffi_call_get_u8(const ScrFfiCall *call, size_t i) { return (double)scr_ffi_get_arg(call, i)->value.u32; }
double scr_ffi_call_get_u32(const ScrFfiCall *call, size_t i) { return (double)scr_ffi_get_arg(call, i)->value.u32; }
double scr_ffi_call_get_i32(const ScrFfiCall *call, size_t i) { return (double)scr_ffi_get_arg(call, i)->value.i32; }
const uint8_t *scr_ffi_call_get_data(const ScrFfiCall *call, size_t i) { return scr_ffi_get_arg(call, i)->value.span.data; }
size_t scr_ffi_call_get_len(const ScrFfiCall *call, size_t i) { return scr_ffi_get_arg(call, i)->value.span.len; }

static bool scr_ffi_pending(void) {
  bool pending;
  scr_ffi_lock_enter();
  pending = scr_ffi_foreign_registrations > 0 || scr_ffi_head != NULL;
  scr_ffi_lock_leave();
  return pending;
}

static void scr_ffi_wake_drain(void) {
#if !defined(_WIN32) && !defined(__wasi__)
  if (scr_ffi_wake_pipe[0] < 0) return;
  char buf[64];
  while (read(scr_ffi_wake_pipe[0], buf, sizeof buf) > 0) {}
#endif
}

static bool scr_ffi_dispatch(void) {
  scr_ffi_lock_enter();
  ScrFfiCall *call = scr_ffi_head;
  if (call != NULL) {
    scr_ffi_head = call->next;
    if (scr_ffi_head == NULL) scr_ffi_tail = NULL;
  }
  scr_ffi_lock_leave();
  if (call == NULL) return false;

  call->dispatch(call->callback, call);

  ScrFfiTable *table = call->table;
  scr_ffi_lock_enter();
  if (table->queued > 0) table->queued--;
  /* Keep the wake fd readable while queued calls remain. Drain only while
   * holding the same lock writers use, closing the post-vs-drain lost-wakeup
   * race for the transition to an empty queue. */
  bool more = scr_ffi_head != NULL;
  if (!more) scr_ffi_wake_drain();
  scr_ffi_lock_leave();
  scr_ffi_call_free(call);
  scr_ffi_release_retired(table);
  return true;
}

static int scr_ffi_pollfd(void) { return scr_ffi_wake_pipe[0]; }

void scr_ffi_install(void) {
  if (scr_ffi_installed) return;
  scr_ffi_installed = true;
#if !defined(_WIN32) && !defined(__wasi__)
  if (pipe(scr_ffi_wake_pipe) == 0) {
    for (int i = 0; i < 2; i++) {
      (void)fcntl(scr_ffi_wake_pipe[i], F_SETFL, O_NONBLOCK);
      (void)fcntl(scr_ffi_wake_pipe[i], F_SETFD, FD_CLOEXEC);
    }
  } else {
    scr_ffi_wake_pipe[0] = scr_ffi_wake_pipe[1] = -1;
  }
#endif
  scr_loop_set_ffi(&scr_ffi_pending, &scr_ffi_dispatch, &scr_ffi_pollfd,
                   &scr_ffi_stop);
}

void scr_ffi_stop(void) {
  scr_ffi_lock_enter();
  if (scr_ffi_stopping) {
    scr_ffi_lock_leave();
    return;
  }
  scr_ffi_stopping = true;
  ScrFfiCall *calls = scr_ffi_head;
  scr_ffi_head = scr_ffi_tail = NULL;
  for (ScrFfiCall *call = calls; call != NULL; call = call->next) {
    if (call->table->queued > 0) call->table->queued--;
  }
  scr_ffi_wake_drain();
#if !defined(_WIN32) && !defined(__wasi__)
  if (scr_ffi_wake_pipe[0] >= 0) close(scr_ffi_wake_pipe[0]);
  if (scr_ffi_wake_pipe[1] >= 0) close(scr_ffi_wake_pipe[1]);
#endif
  scr_ffi_wake_pipe[0] = scr_ffi_wake_pipe[1] = -1;
  scr_ffi_lock_leave();
  while (calls != NULL) {
    ScrFfiCall *next = calls->next;
    ScrFfiTable *table = calls->table;
    scr_ffi_call_free(calls);
    scr_ffi_release_retired(table);
    calls = next;
  }
}

void scr_ffi_teardown_foreign(ScrFfiTable *table) {
  scr_ffi_stop();
  scr_ffi_lock_enter();
  ScrClosure **entries = table->entries;
  size_t len = table->len;
  ScrClosure **retired = table->retired;
  size_t retired_len = table->retired_len;
  if (scr_ffi_foreign_registrations >= len) scr_ffi_foreign_registrations -= len;
  table->entries = NULL;
  table->len = 0;
  table->cap = 0;
  table->retired = NULL;
  table->retired_len = 0;
  table->retired_cap = 0;
  table->queued = 0;
  scr_ffi_lock_leave();
  for (size_t i = 0; i < len; i++) scr_closure_release(entries[i]);
  free(entries);
  for (size_t i = 0; i < retired_len; i++) scr_closure_release(retired[i]);
  free(retired);
}
