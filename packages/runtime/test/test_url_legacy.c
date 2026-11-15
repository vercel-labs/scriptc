/* Oracle test for node:url's legacy API and the domain pair.
 * Reads the case file given as argv[1] (line format in
 * gen-url-legacy-cases.mjs) and compares url.domainToASCII/domainToUnicode,
 * url.parse (as its JSON), url.format over strings and objects, and
 * url.resolve with Node's answers; a throwing call answers "E:" and the
 * error's code (or name).
 *
 * Exit 0 = all pass; prints each mismatch (capped) and exits 1 otherwise.
 */
#include "../src/scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

long scr_str_live_count(void); /* provided by scr_string.c */

/* Warnings are not part of the answers (DEP0169 is off: warn = false;
 * DEP0170 still fires); the deprecation unit stays out. */
ScrDyn *scr_warning_new(ScrStr *message, const char *type, const ScrStr *code) {
  (void)message;
  (void)type;
  (void)code;
  return scr_dyn_new_null();
}
void scr_warning_emit_deferred(ScrDyn *warning) { (void)warning; }

static int hex_val(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return -1;
}

/* An escaped case string (printable ASCII, \uXXXX code units) to a string
 * in the runtime's WTF-8 storage. */
static ScrStr *decode(const char *text) {
  size_t len = strlen(text);
  uint16_t *units = malloc((len ? len : 1) * sizeof *units);
  size_t n = 0;
  for (size_t i = 0; i < len; i++) {
    if (text[i] == '\\' && text[i + 1] == 'u') {
      const char *h = text + i + 2;
      units[n++] = (uint16_t)(hex_val(h[0]) << 12 | hex_val(h[1]) << 8 | hex_val(h[2]) << 4 | hex_val(h[3]));
      i += 5;
    } else {
      units[n++] = (uint8_t)text[i];
    }
  }
  char *out = malloc(3 * n + 1);
  size_t w = 0;
  bool lone = false;
  for (size_t i = 0; i < n; i++) {
    uint32_t cp = units[i];
    if (cp >= 0xD800 && cp < 0xDC00 && i + 1 < n && units[i + 1] >= 0xDC00 && units[i + 1] < 0xE000) {
      cp = 0x10000 + ((cp - 0xD800) << 10) + (units[i + 1] - 0xDC00);
      i++;
    } else if (cp >= 0xD800 && cp < 0xE000) {
      lone = true;
    }
    if (cp < 0x80) {
      out[w++] = (char)cp;
    } else if (cp < 0x800) {
      out[w++] = (char)(0xC0 | (cp >> 6));
      out[w++] = (char)(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
      out[w++] = (char)(0xE0 | (cp >> 12));
      out[w++] = (char)(0x80 | ((cp >> 6) & 0x3F));
      out[w++] = (char)(0x80 | (cp & 0x3F));
    } else {
      out[w++] = (char)(0xF0 | (cp >> 18));
      out[w++] = (char)(0x80 | ((cp >> 12) & 0x3F));
      out[w++] = (char)(0x80 | ((cp >> 6) & 0x3F));
      out[w++] = (char)(0x80 | (cp & 0x3F));
    }
  }
  if (lone) scr_wtf8_note();
  ScrStr *s = scr_str_new(out, w);
  free(out);
  free(units);
  return s;
}

/* Splits a line at tabs in place; empty fields are kept. */
static int split(char *line, char **fields, int max) {
  int count = 0;
  fields[count++] = line;
  for (char *c = line; *c; c++)
    if (*c == '\t') {
      *c = 0;
      if (count == max) return -1;
      fields[count++] = c + 1;
    }
  return count;
}

/* "E:<code or name>" for the pending exception (+1). */
static ScrStr *error_outcome(void) {
  if (!scr_exc_pending()) return scr_str_new("E:<none pending>", 16);
  ScrCaught *c = scr_exc_take();
  ScrError *error = c->payload;
  ScrStr *label = error->code ? scr_str_retain(error->code) : scr_error_default_name(error);
  ScrStr *prefix = scr_str_new("E:", 2);
  ScrStr *out = scr_str_concat(prefix, label);
  scr_str_release(prefix);
  scr_str_release(label);
  scr_caught_release(c);
  return out;
}

static ScrStr *string_outcome(ScrStr *result) { return result ? result : error_outcome(); }

static ScrStr *json_outcome(ScrDyn *result) {
  if (!result) return error_outcome();
  ScrJsonBuf b;
  scr_jb_init(&b);
  scr_jb_put_dyn(&b, result);
  scr_dyn_release(result);
  return scr_jb_finish(&b);
}

static long total, failed;

static void check(ScrStr *got, const char *expected_text, const char *kind, const char *a, const char *b) {
  ScrStr *expected = decode(expected_text);
  total++;
  if (got->len != expected->len || memcmp(got->data, expected->data, got->len) != 0) {
    failed++;
    if (failed <= 40)
      fprintf(stderr, "MISMATCH %s \"%s\"%s%s%s\n  got  %.*s\n  want %.*s\n", kind, a, b ? " \"" : "",
              b ? b : "", b ? "\"" : "", (int)got->len, got->data, (int)expected->len, expected->data);
  }
  scr_str_release(expected);
  scr_str_release(got);
}

int main(int argc, char **argv) {
  if (argc < 2) return 2;
  FILE *f = fopen(argv[1], "r");
  if (!f) return 2;
  static char line[1 << 20];
  ScrDyn *no = scr_dyn_new_bool(false);
  ScrDyn *yes = scr_dyn_new_bool(true);
  while (fgets(line, sizeof line, f)) {
    size_t len = strlen(line);
    if (len && line[len - 1] == '\n') line[--len] = 0;
    if (!len) continue;
    char *fields[5];
    int count = split(line, fields, 5);
    const char *kind = fields[0];
    if ((strcmp(kind, "a") == 0 || strcmp(kind, "u") == 0) && count == 3) {
      ScrStr *input = decode(fields[1]);
      ScrDyn *boxed = scr_dyn_new_str(input);
      ScrStr *got = kind[0] == 'a' ? scr_url_domain_to_ascii(boxed, false)
                                   : scr_url_domain_to_unicode(boxed, false);
      check(string_outcome(got), fields[2], kind, fields[1], NULL);
      scr_dyn_release(boxed);
      scr_str_release(input);
    } else if (strcmp(kind, "p") == 0 && count == 4) {
      int flags = atoi(fields[1]);
      ScrStr *input = decode(fields[2]);
      ScrDyn *boxed = scr_dyn_new_str(input);
      ScrDyn *got = scr_url_legacy_parse(boxed, flags & 1 ? yes : no, flags & 2 ? yes : no, false);
      check(json_outcome(got), fields[3], flags & 1 ? (flags & 2 ? "p3" : "p1") : flags & 2 ? "p2" : "p0",
            fields[2], NULL);
      scr_dyn_release(boxed);
      scr_str_release(input);
    } else if (strcmp(kind, "f") == 0 && count == 3) {
      ScrStr *input = decode(fields[1]);
      ScrDyn *boxed = scr_dyn_new_str(input);
      check(string_outcome(scr_url_legacy_format(boxed, scr_dyn_undefined(), false)), fields[2], kind,
            fields[1], NULL);
      scr_dyn_release(boxed);
      scr_str_release(input);
    } else if (strcmp(kind, "o") == 0 && count == 3) {
      ScrStr *text = decode(fields[1]);
      ScrDyn *object = scr_json_parse(text);
      check(string_outcome(scr_url_legacy_format(object, scr_dyn_undefined(), false)), fields[2], kind,
            fields[1], NULL);
      scr_dyn_release(object);
      scr_str_release(text);
    } else if (strcmp(kind, "r") == 0 && count == 4) {
      ScrStr *from = decode(fields[1]);
      ScrStr *to = decode(fields[2]);
      ScrDyn *from_boxed = scr_dyn_new_str(from);
      ScrDyn *to_boxed = scr_dyn_new_str(to);
      check(string_outcome(scr_url_legacy_resolve(from_boxed, to_boxed, false)), fields[3], kind, fields[1],
            fields[2]);
      scr_dyn_release(from_boxed);
      scr_dyn_release(to_boxed);
      scr_str_release(from);
      scr_str_release(to);
    } else {
      fprintf(stderr, "bad line: %s\n", kind);
      return 2;
    }
  }
  fclose(f);
  scr_dyn_release(no);
  scr_dyn_release(yes);
#ifdef SCR_RC_AUDIT
  /* The Url class (constructor and prototype) is initialized by the first
   * parse() result and kept for the process; the emptiness audit runs before
   * atexit, so release it here. */
  scr_url_legacy_class_release();
  if (scr_str_live_count() != 0) {
    fprintf(stderr, "live strings at exit: %ld\n", scr_str_live_count());
    failed++;
  }
#endif
  fprintf(stderr, "%ld/%ld cases passed\n", total - failed, total);
  return failed == 0 ? 0 : 1;
}
