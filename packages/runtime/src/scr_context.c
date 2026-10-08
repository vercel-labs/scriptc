#include "scr_runtime.h"

#ifdef SCR_WORKERS
#include <stdlib.h>
#include <stdatomic.h>

void scr_runtime_workers_v8(void) {}

typedef struct ScrContextExit {
  void (*fn)(void);
  struct ScrContextExit *next;
} ScrContextExit;

static SCR_TL ScrContextExit *scr_context_exits;
static SCR_TL uint64_t scr_context_id;
static SCR_TL const atomic_bool *scr_context_cancel;
static SCR_TL bool scr_context_stopped;
SCR_TL void (*scr_context_report_error)(void);

typedef struct { char *name; char *value; } ScrContextEnvEntry;
struct ScrContextEnv { size_t count; ScrContextEnvEntry *entries; };
static SCR_TL ScrContextEnv *scr_context_environment;

static char *scr_context_text_copy(const char *value) {
  size_t length = strlen(value);
  char *copy = malloc(length + 1);
  if (!copy) scr_trap("scriptc: out of memory\n");
  memcpy(copy, value, length + 1);
  return copy;
}

ScrContextEnv *scr_context_env_capture(void) {
  ScrArr *pairs = scr_env_pairs();
  ScrContextEnv *environment = calloc(1, sizeof(*environment));
  if (!environment) scr_trap("scriptc: out of memory\n");
  environment->count = pairs->len / 2;
  environment->entries = calloc(environment->count ? environment->count : 1, sizeof(*environment->entries));
  if (!environment->entries) scr_trap("scriptc: out of memory\n");
  for (size_t i = 0; i < environment->count; i++) {
    ScrStr *key = scr_arr_get_ref(pairs, (double)(2 * i));
    ScrStr *value = scr_arr_get_ref(pairs, (double)(2 * i + 1));
    environment->entries[i] = (ScrContextEnvEntry){scr_context_text_copy(key->data), scr_context_text_copy(value->data)};
    scr_str_release(key); scr_str_release(value);
  }
  scr_arr_release(pairs);
  return environment;
}

void scr_context_env_free(ScrContextEnv *environment) {
  if (!environment) return;
  for (size_t i = 0; i < environment->count; i++) {
    free(environment->entries[i].name); free(environment->entries[i].value);
  }
  free(environment->entries); free(environment);
}

static void scr_context_env_cleanup(void) {
  scr_context_env_free(scr_context_environment);
  scr_context_environment = NULL;
}

void scr_context_env_enter(ScrContextEnv *environment) {
  scr_context_environment = environment;
  if (scr_context_atexit(scr_context_env_cleanup)) scr_trap("scriptc: out of memory\n");
}

const char *scr_context_getenv(const char *name) {
  if (!scr_context_environment) return getenv(name);
  for (size_t i = 0; i < scr_context_environment->count; i++)
    if (!strcmp(scr_context_environment->entries[i].name, name)) return scr_context_environment->entries[i].value;
  return NULL;
}

bool scr_context_env_set(const char *name, const char *value) {
  ScrContextEnv *environment = scr_context_environment;
  if (!environment) return false;
  for (size_t i = 0; i < environment->count; i++) {
    ScrContextEnvEntry *entry = &environment->entries[i];
    if (strcmp(entry->name, name)) continue;
    char *copy = value ? scr_context_text_copy(value) : NULL;
    free(entry->value);
    entry->value = copy;
    if (!copy) {
      free(entry->name);
      memmove(entry, entry + 1, (--environment->count - i) * sizeof(*entry));
    }
    return true;
  }
  if (value) {
    ScrContextEnvEntry *entries = realloc(environment->entries, (environment->count + 1) * sizeof(*entries));
    if (!entries) scr_trap("scriptc: out of memory\n");
    environment->entries = entries;
    entries[environment->count++] = (ScrContextEnvEntry){scr_context_text_copy(name), scr_context_text_copy(value)};
  }
  return true;
}

ScrArr *scr_context_env_pairs(void) {
  if (!scr_context_environment) return NULL;
  ScrArr *out = scr_arr_new(SCR_ELEM_STR, 0);
  for (size_t i = 0; i < scr_context_environment->count; i++) {
    const ScrContextEnvEntry *entry = &scr_context_environment->entries[i];
    scr_arr_push_ref(out, scr_str_new(entry->name, strlen(entry->name)));
    scr_arr_push_ref(out, scr_str_new(entry->value, strlen(entry->value)));
  }
  return out;
}

void scr_context_enter(uint64_t thread_id) { scr_context_id = thread_id; }
bool scr_context_is_main(void) { return scr_context_id == 0; }
uint64_t scr_context_thread_id(void) { return scr_context_id; }
double scr_context_thread_number(void) { return (double)scr_context_id; }

void scr_context_stop_flag(const void *flag) { scr_context_cancel = flag; }
bool scr_context_stopping(void) { return scr_context_stopped; }

void scr_context_stop(int code) {
  scr_context_stopped = true;
  scr_exit_code_note(code);
  scr_exc_clear();
  scr_exc_current_cell()->kind = SCR_EXC_TERMINATE;
}

bool scr_context_checkpoint(void) {
  if (!scr_context_stopped && scr_context_cancel &&
      atomic_load_explicit(scr_context_cancel, memory_order_relaxed)) scr_context_stop(1);
  if (!scr_context_stopped) return false;
  /* Each fiber has its own exception cell. Reinstall the sentinel after a
   * context switch or a runtime continuation consumes its pending payload. */
  if (scr_exc_current_cell()->kind != SCR_EXC_TERMINATE) {
    scr_exc_clear();
    scr_exc_current_cell()->kind = SCR_EXC_TERMINATE;
  }
  return true;
}

int scr_context_atexit(void (*fn)(void)) {
  ScrContextExit *entry = malloc(sizeof(*entry));
  if (!entry) return -1;
  entry->fn = fn;
  entry->next = scr_context_exits;
  scr_context_exits = entry;
  return 0;
}

void scr_context_cleanup(void) {
  scr_loop_context_shutdown();
  /* Pop before calling: a callback may register further cleanup. Those
   * registrations run first, just as newly registered libc exit handlers do.
   * Repeated cleanup is harmless after the list has been drained. */
  while (scr_context_exits) {
    ScrContextExit *entry = scr_context_exits;
    scr_context_exits = entry->next;
    void (*fn)(void) = entry->fn;
    free(entry);
    fn();
  }
  scr_exc_clear();
  scr_cyc_context_cleanup();
}
#else
bool scr_context_is_main(void) { return true; }
double scr_context_thread_number(void) { return 0; }
double scr_worker_root(void) { return -1; }
ScrDyn *scr_worker_data(void) { return scr_dyn_new_null(); }
ScrDyn *scr_worker_parent_port(void) { return scr_dyn_new_null(); }
#endif
