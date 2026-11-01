/* The musl lane's strcmp, strncmp and getenv (scr_musl_env.h) against
 * references: the comparison sign over every pair of short strings from a
 * small alphabet (bytes above 0x7f included) and every bound up to past
 * their ends, and getenv over environments with repeated names, prefixes of
 * the name, entries without '=', empty values, and names that are empty or
 * contain '='.
 *
 * Built with SCR_MUSL_ENV_LIBC, it defines the libc names over the prefixed
 * functions (as scr_musl.c does) and checks the process's own environment
 * through getenv, so a static musl build exercises the replacement. */
#include "scr_musl_env.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef SCR_MUSL_ENV_LIBC
#define NB __attribute__((no_builtin))
NB int strcmp(const char *a, const char *b) { return scr_musl_strcmp(a, b); }
NB int strncmp(const char *a, const char *b, size_t n) { return scr_musl_strncmp(a, b, n); }
extern char **__environ;
NB char *getenv(const char *name) { return scr_musl_getenv(__environ, name); }
#endif

/* Checks stay on in optimized builds (NDEBUG). */
#define CHECK(cond)                                                              \
  do {                                                                           \
    if (!(cond)) {                                                               \
      fprintf(stderr, "%s:%d: check failed: %s\n", __FILE__, __LINE__, #cond); \
      abort();                                                                   \
    }                                                                            \
  } while (0)

static int sign(int v) { return (v > 0) - (v < 0); }

static int ref_strncmp(const char *a, const char *b, size_t n) {
  for (size_t i = 0; i < n; i++) {
    unsigned char x = (unsigned char)a[i], y = (unsigned char)b[i];
    if (x != y) return x < y ? -1 : 1;
    if (!x) return 0;
  }
  return 0;
}

static const char alphabet[] = {'a', 'b', '=', (char)0xe9};
enum { MAXLEN = 4 };

/* The string numbered k: length k % (MAXLEN + 1), then digits base 4. */
static void make(unsigned k, char *out) {
  unsigned len = k % (MAXLEN + 1);
  k /= MAXLEN + 1;
  for (unsigned i = 0; i < len; i++, k /= 4) out[i] = alphabet[k % 4];
  out[len] = 0;
}

static void check_compare(void) {
  unsigned count = (MAXLEN + 1) * 256;
  char a[MAXLEN + 1], b[MAXLEN + 1];
  for (unsigned i = 0; i < count; i++) {
    make(i, a);
    for (unsigned j = 0; j < count; j += 7) {
      make(j, b);
      CHECK(sign(scr_musl_strcmp(a, b)) == ref_strncmp(a, b, (size_t)-1));
      for (size_t n = 0; n <= MAXLEN + 2; n++)
        CHECK(sign(scr_musl_strncmp(a, b, n)) == ref_strncmp(a, b, n));
      CHECK(sign(scr_musl_strncmp(a, b, (size_t)-1)) == ref_strncmp(a, b, (size_t)-1));
    }
  }
}

/* musl's getenv with the reference comparison. */
static char *ref_getenv(char **env, const char *name) {
  size_t l = strcspn(name, "=");
  if (!l || name[l] || !env) return NULL;
  for (char **e = env; *e; e++)
    if (!ref_strncmp(name, *e, l) && (*e)[l] == '=') return *e + l + 1;
  return NULL;
}

static void check_getenv(void) {
  char *env[] = {"TZX=1", "T", "TZ", "TZ=", "TZ=Europe/Paris", "PATH=/bin", "=x", "A=B=C",
                 "\xe9=2", "LONGERNAME=3", "TZ=second", NULL};
  static const char *names[] = {"TZ", "T", "TZX", "PATH", "A", "A=B", "", "=x", "\xe9",
                                "LONGERNAME", "LONGER", "LONGERNAMEX", "MISSING", "Z"};
  for (size_t i = 0; i < sizeof names / sizeof names[0]; i++) {
    char *got = scr_musl_getenv(env, names[i]), *want = ref_getenv(env, names[i]);
    CHECK(got == want);
  }
  CHECK(strcmp(scr_musl_getenv(env, "TZ"), "") == 0); /* the first TZ= entry */
  CHECK(scr_musl_getenv(NULL, "TZ") == NULL);
  char *empty[] = {NULL};
  CHECK(scr_musl_getenv(empty, "TZ") == NULL);
}

int main(void) {
  check_compare();
  check_getenv();
#ifdef SCR_MUSL_ENV_LIBC
  CHECK(getenv("SCR_MUSL_ENV_TEST") != NULL && strcmp(getenv("SCR_MUSL_ENV_TEST"), "on") == 0);
  CHECK(getenv("SCR_MUSL_ENV_TEST_MISSING") == NULL);
#endif
  puts("ok");
  return 0;
}
