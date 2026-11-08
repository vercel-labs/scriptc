/* A deferred refusal that fires (the IR's runtimeFence): the compiler knew
 * at build time that the operation at this site does not compile, and
 * deferred the refusal to the operation that reaches it. The site throws its
 * catchable Error, exactly as scr_throw_error_msg_code does. Before the
 * first throw of each site this unit writes the refusal to stderr (its code
 * and source position are part of the message), so a handler that catches
 * the Error cannot turn a compiler gap into an unexplained wrong answer.
 * SCRIPTC_DEFERRED_REPORT=0 silences the lines.
 *
 * A site that sits in the `try` block of a `try`/`catch` of its own
 * function has the program's handler for exactly that statement, and the
 * build named it (SC6012). It throws through scr_deferred_fence_guarded,
 * which writes nothing unless SCRIPTC_DEFERRED_REPORT=all asks for every
 * site: a program that guards an optional call keeps Node's stderr.
 *
 * Only a program that contains a runtimeFence references this unit, so no
 * other program links it or can print the line. */
#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* The sites that have reported, by the address of their message: the
 * compiler emits one constant per distinct message, and a message names its
 * site. A process has as many entries as it has sites that fired. */
static const char **scr_fence_sites;
static size_t scr_fence_sites_len, scr_fence_sites_cap;
/* Worker threads reach fences too. */
static char scr_fence_lock;

/* Whether this is the first time `site` fires in the process and its
 * report is wanted. `guarded` is a site inside its own try/catch. */
static bool scr_fence_first(const char *site, bool guarded) {
  const char *setting = getenv("SCRIPTC_DEFERRED_REPORT");
  if (setting != NULL && strcmp(setting, "0") == 0) return false;
  if (guarded && (setting == NULL || strcmp(setting, "all") != 0)) return false;
  while (__atomic_test_and_set(&scr_fence_lock, __ATOMIC_ACQUIRE)) {
  }
  bool first = true;
  for (size_t i = 0; i < scr_fence_sites_len; i++) {
    if (scr_fence_sites[i] == site) {
      first = false;
      break;
    }
  }
  if (first) {
    if (scr_fence_sites_len == scr_fence_sites_cap) {
      size_t cap = scr_fence_sites_cap ? scr_fence_sites_cap * 2 : 16;
      const char **grown = realloc(scr_fence_sites, cap * sizeof *grown);
      /* Without memory for the table the site reports again next time. */
      if (grown != NULL) {
        scr_fence_sites = grown;
        scr_fence_sites_cap = cap;
      }
    }
    if (scr_fence_sites_len < scr_fence_sites_cap) scr_fence_sites[scr_fence_sites_len++] = site;
  }
  bool hint = first && scr_fence_sites_len <= 1;
  __atomic_clear(&scr_fence_lock, __ATOMIC_RELEASE);
  if (!first) return false;
  /* Settle stdout before the stderr lines when both share an fd, as the
   * uncaught-error report does. */
  scr_stdout_settle();
  fflush(stdout);
  if (hint)
    fputs("scriptc: this program reached code that scriptc could not compile; each such "
          "operation throws where it runs and is reported here once ('scriptc coverage' lists "
          "them, SCRIPTC_DEFERRED_REPORT=0 silences these lines)\n",
          stderr);
  return true;
}

static void scr_fence_throw(const char *message, size_t len, const char *code, bool guarded) {
  if (scr_fence_first(message, guarded)) {
    fputs("scriptc: not compiled: ", stderr);
    fwrite(message, 1, len, stderr);
    /* A message that carries no position still names its code. */
    if (strstr(message, code) == NULL) fprintf(stderr, " [%s]", code);
    fputc('\n', stderr);
    fflush(stderr);
  }
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, len, code);
}

void scr_deferred_fence(const char *message, size_t len, const char *code) {
  scr_fence_throw(message, len, code, false);
}

void scr_deferred_fence_guarded(const char *message, size_t len, const char *code) {
  scr_fence_throw(message, len, code, true);
}
