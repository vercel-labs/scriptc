/* String comparison and environment lookup for the musl lane (scr_musl.c).
 *
 * The musl lane links zig's libc, whose strcmp and strncmp are generic
 * bounded comparisons, and musl's getenv calls strncmp once for every
 * environment entry. musl's localtime_r looks TZ up that way on every call,
 * so a program converting many dates to local time spends most of that time
 * scanning the environment. These are musl's own definitions, with getenv
 * comparing the first byte of each entry inline before the rest.
 *
 * The functions are prefixed so that the test (scr_musl_env.test.c) can
 * compile them on any host; scr_musl.c defines the libc names over them. */
#ifndef SCR_MUSL_ENV_H
#define SCR_MUSL_ENV_H

#include <stddef.h>

#define SCR_MUSL_ENV_FN static inline __attribute__((no_builtin, always_inline))

SCR_MUSL_ENV_FN int scr_musl_strcmp(const char *a, const char *b) {
  const unsigned char *l = (const unsigned char *)a, *r = (const unsigned char *)b;
  for (; *l == *r && *l; l++, r++) {
  }
  return *l - *r;
}

SCR_MUSL_ENV_FN int scr_musl_strncmp(const char *a, const char *b, size_t n) {
  const unsigned char *l = (const unsigned char *)a, *r = (const unsigned char *)b;
  if (!n--) return 0;
  for (; *l && *r && n && *l == *r; l++, r++, n--) {
  }
  return *l - *r;
}

/* getenv over `env` (the process's environ): the value of the first entry
 * `name=value`, or NULL. A name that is empty or contains '=' matches no
 * entry, as in musl. */
SCR_MUSL_ENV_FN char *scr_musl_getenv(char **env, const char *name) {
  size_t len = 0;
  while (name[len] && name[len] != '=') len++;
  if (!len || name[len] || !env) return NULL;
  for (char **e = env; *e; e++) {
    const char *s = *e;
    if (s[0] != name[0]) continue;
    size_t i = 1;
    while (i < len && s[i] == name[i]) i++;
    if (i == len && s[len] == '=') return (char *)s + len + 1;
  }
  return NULL;
}

#endif
