/* Declared-type origins on checked-conversion TypeErrors, linked only by
 * programs that check values against types an npm package declares
 * (runtime feature typeOrigins).
 *
 * A checked conversion into a type that comes from a package's
 * declarations (its .d.ts, @types package or JSDoc) throws the usual
 * `expected <type> at <path>, got <kind>` TypeError when the value does
 * not fit. The compiler passes the declaration's origin to the conversion
 * site's cold exception path, which calls scr_type_origin_note: the
 * pending TypeError's message gains two lines naming the declaration and
 * the type patch (package.json scriptc.typePatches) that would make the
 * declaration admit the value, as the `scriptc types patch` command that
 * writes it. The hot path is unchanged, and so is every
 * other error.
 *
 * The origin is one string of fields separated by \x1f: package, version,
 * suggested range (which the command chooses itself), the selector of the
 * declared slot, where it is declared, and the declared type. */
#include "scr_runtime.h"

#include <stdlib.h>
#include <string.h>

typedef struct {
  char *data;
  size_t len, cap;
} ScrOriginBuf;

static void scr_origin_put(ScrOriginBuf *b, const char *s, size_t n) {
  if (b->len + n + 1 > b->cap) {
    size_t cap = b->cap ? b->cap : 256;
    while (b->len + n + 1 > cap) cap *= 2;
    char *grown = realloc(b->data, cap);
    if (!grown) scr_trap("scriptc: out of memory\n");
    b->data = grown;
    b->cap = cap;
  }
  memcpy(b->data + b->len, s, n);
  b->len += n;
  b->data[b->len] = 0;
}

static void scr_origin_puts(ScrOriginBuf *b, const char *s) { scr_origin_put(b, s, strlen(s)); }

/* One argument of the suggested `scriptc types patch` command, quoted as
 * the shell passes it as written (decl-origin.ts's shellArgument quotes the
 * same way): bare when it has only characters no shell treats specially;
 * otherwise, for a POSIX shell, in single quotes with each ' as '\'', and
 * on Windows (cmd and PowerShell), in double quotes when it has none of the
 * characters either shell expands, escapes or ends a string with there.
 * Package names, selectors and types come from package declarations.
 * Returns false, writing nothing, when no quoting is inert. */
static bool scr_origin_bare(const char *s, size_t n) {
  if (n == 0) return false;
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)s[i];
    bool plain = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
                 strchr("_@+=:,./-", c) != NULL;
#ifndef _WIN32
    plain = plain || c == '%';
#endif
    if (!plain || c == 0) return false;
  }
  return true;
}

static bool scr_origin_quotable(const char *s, size_t n) {
#ifdef _WIN32
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)s[i];
    if (c < 0x20 || c == 0x7f || (c != 0 && strchr("\"%!^$`", c) != NULL)) return false;
    /* PowerShell also takes the typographic quotes U+2018-U+201F (UTF-8
     * E2 80 98..9F) as quotes. */
    if (c == 0xe2 && i + 2 < n && (unsigned char)s[i + 1] == 0x80 &&
        (unsigned char)s[i + 2] >= 0x98 && (unsigned char)s[i + 2] <= 0x9f)
      return false;
  }
#else
  (void)s;
  (void)n;
#endif
  return true;
}

static void scr_origin_put_arg(ScrOriginBuf *b, const char *s, size_t n) {
  if (scr_origin_bare(s, n)) {
    scr_origin_put(b, s, n);
    return;
  }
#ifdef _WIN32
  scr_origin_puts(b, "\"");
  scr_origin_put(b, s, n);
  scr_origin_puts(b, "\"");
#else
  scr_origin_puts(b, "'");
  for (size_t i = 0; i < n; i++) {
    if (s[i] == '\'') scr_origin_puts(b, "'\\''");
    else scr_origin_put(b, s + i, 1);
  }
  scr_origin_puts(b, "'");
#endif
}

/* Field `index` of the origin string (not terminated: [*out, *out+len)). */
static size_t scr_origin_field(const char *origin, int index, const char **out) {
  const char *p = origin;
  for (int i = 0; i < index; i++) {
    const char *sep = strchr(p, '\x1f');
    if (!sep) {
      *out = "";
      return 0;
    }
    p = sep + 1;
  }
  const char *end = strchr(p, '\x1f');
  *out = p;
  return end ? (size_t)(end - p) : strlen(p);
}

/* The TypeScript type a `got` kind of the check message suggests adding. */
static const char *scr_origin_arm(const char *kind, size_t len) {
  if (len == 5 && memcmp(kind, "array", 5) == 0) return "unknown[]";
  if (len == 8 && memcmp(kind, "function", 8) == 0) return "Function";
  return NULL; /* the kind itself (undefined, null, string, number, ...) */
}

void scr_type_origin_note(const char *origin) {
  ScrExcCell *cell = scr_exc_current_cell();
  if (cell->kind != SCR_EXC_OBJ || cell->payload == NULL) return;
  ScrError *e = (ScrError *)cell->payload;
  if (e->vt != &scr_error_vts[SCR_ERR_TYPE] || e->message == NULL) return;
  const char *msg = e->message->data;
  size_t mlen = e->message->len;
  if (memchr(msg, '\n', mlen) != NULL) return; /* already noted */
  /* `expected <type> at <path>, got <kind>`: the path extends the
   * declared slot's selector, the kind is what the patch admits. */
  const char *path = NULL, *got = NULL;
  size_t path_len = 0, got_len = 0;
  if (mlen > 9 && memcmp(msg, "expected ", 9) == 0) {
    for (size_t i = mlen; i-- > 7;) {
      if (memcmp(msg + i - 6, ", got ", 6) == 0) {
        got = msg + i;
        got_len = mlen - i;
        for (size_t j = i - 6; j-- > 4;) {
          if (memcmp(msg + j - 4, " at $", 5) == 0) {
            path = msg + j;
            path_len = i - 6 - j;
            break;
          }
        }
        break;
      }
    }
  }
  const char *pkg, *version, *selector, *where, *declared;
  size_t pkg_len = scr_origin_field(origin, 0, &pkg);
  size_t version_len = scr_origin_field(origin, 1, &version);
  size_t selector_len = scr_origin_field(origin, 3, &selector);
  size_t where_len = scr_origin_field(origin, 4, &where);
  size_t declared_len = scr_origin_field(origin, 5, &declared);

  ScrOriginBuf b = {0};
  scr_origin_put(&b, msg, mlen);
  scr_origin_puts(&b, "\n    ");
  scr_origin_put(&b, pkg, pkg_len);
  if (version_len > 0) {
    scr_origin_puts(&b, "@");
    scr_origin_put(&b, version, version_len);
  }
  scr_origin_puts(&b, " declares ");
  scr_origin_put(&b, selector, selector_len);
  if (declared_len > 0) {
    scr_origin_puts(&b, " as ");
    scr_origin_put(&b, declared, declared_len);
  }
  scr_origin_puts(&b, " (");
  scr_origin_put(&b, where, where_len);
  scr_origin_puts(&b, ")\n    ");
  ScrOriginBuf sel = {0}, type = {0};
  scr_origin_put(&sel, selector, selector_len);
  /* $[3].email extends the selector as [].email: elements of an array
   * share one declared type. */
  for (size_t i = 1; path != NULL && i < path_len; i++) {
    if (path[i] == '[') {
      scr_origin_puts(&sel, "[]");
      while (i < path_len && path[i] != ']') i++;
    } else {
      scr_origin_put(&sel, path + i, 1);
    }
  }
  scr_origin_puts(&type, "| ");
  if (got != NULL) {
    const char *arm = scr_origin_arm(got, got_len);
    if (arm != NULL) scr_origin_puts(&type, arm);
    else scr_origin_put(&type, got, got_len);
  } else {
    scr_origin_puts(&type, "undefined");
  }
  if (scr_origin_quotable(pkg, pkg_len) && scr_origin_quotable(sel.data, sel.len) &&
      scr_origin_quotable(type.data, type.len)) {
    scr_origin_puts(&b, "if that declaration is wrong, patch it: scriptc types patch ");
    scr_origin_put_arg(&b, pkg, pkg_len);
    scr_origin_puts(&b, " ");
    scr_origin_put_arg(&b, sel.data, sel.len);
    scr_origin_puts(&b, " ");
    scr_origin_put_arg(&b, type.data, type.len);
  } else {
    scr_origin_puts(&b, "if that declaration is wrong, patch it with scriptc types patch");
  }
  free(sel.data);
  free(type.data);

  ScrStr *next = scr_str_new(b.data, b.len);
  free(b.data);
  scr_str_release(e->message);
  e->message = next;
  if (e->stack != NULL) {
    /* The cached `stack` starts with the message. */
    scr_str_release(e->stack);
    e->stack = NULL;
  }
}
