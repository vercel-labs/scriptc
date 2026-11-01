/* Oracle test for the util.inspect runtime engine (scr_inspect.c).
 * Reads case lines ("<op>\t<arg-hex>\t<expected-hex>\n" — see
 * gen-inspect-cases.mjs) from argv[1] and asserts byte equality against
 * what Node's util.inspect produced: numbers, the string quoting ladder,
 * the layout engine (driven through scr_insp_dyn over parsed JSON —
 * frames, break length, grid grouping, depth placeholders), and Buffer's
 * hex form. Exit 0 = all pass; prints each mismatch (capped) otherwise. */
#include "../src/scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_FIELD (1 << 16)

static int hex_val(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

static size_t hex_decode(const char *hex, char *out) {
  if (strcmp(hex, "-") == 0) return 0;
  size_t n = strlen(hex);
  if (n % 2 != 0 || n / 2 > MAX_FIELD) return (size_t)-1;
  for (size_t i = 0; i < n; i += 2) {
    int hi = hex_val(hex[i]), lo = hex_val(hex[i + 1]);
    if (hi < 0 || lo < 0) return (size_t)-1;
    out[i / 2] = (char)((hi << 4) | lo);
  }
  return n / 2;
}

static long total = 0, failed = 0;

static void check(const char *op, const char *arg, size_t arg_len, ScrStr *got,
                  const char *expected, size_t expected_len) {
  total++;
  if (got->len == expected_len && memcmp(got->data, expected, expected_len) == 0) return;
  failed++;
  if (failed <= 25) {
    fprintf(stderr, "MISMATCH %s(%.*s)\n  expected=%.*s\n  got=%.*s\n", op, (int)(arg_len > 200 ? 200 : arg_len),
            arg, (int)expected_len, expected, (int)got->len, got->data);
  }
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fputs("usage: test_inspect <cases-file>\n", stderr);
    return 2;
  }
  FILE *f = fopen(argv[1], "r");
  if (!f) {
    perror("fopen");
    return 2;
  }
  static char line[MAX_FIELD * 4 + 64];
  static char argbuf[MAX_FIELD];
  static char expbuf[MAX_FIELD];
  while (fgets(line, sizeof line, f)) {
    size_t linelen = strlen(line);
    while (linelen > 0 && (line[linelen - 1] == '\n' || line[linelen - 1] == '\r')) {
      line[--linelen] = 0;
    }
    if (linelen == 0) continue;
    char *fields[3];
    int nfields = 0;
    char *cursor = line;
    while (nfields < 3) {
      fields[nfields++] = cursor;
      char *tab = strchr(cursor, '\t');
      if (!tab) break;
      *tab = 0;
      cursor = tab + 1;
    }
    if (nfields != 3) {
      fprintf(stderr, "bad line: %s\n", line);
      return 2;
    }
    const char *op = fields[0];
    size_t arg_len = hex_decode(fields[1], argbuf);
    size_t exp_len = hex_decode(fields[2], expbuf);
    if (arg_len == (size_t)-1 || exp_len == (size_t)-1) {
      fprintf(stderr, "bad hex: %s\n", line);
      return 2;
    }

    ScrStr *result = NULL;
    if (strcmp(op, "f64") == 0) {
      argbuf[arg_len] = 0;
      result = scr_insp_f64(strtod(argbuf, NULL));
    } else if (strcmp(op, "str") == 0) {
      ScrStr *s = scr_str_new(argbuf, arg_len);
      result = scr_insp_str(s);
      scr_str_release(s);
    } else if (strcmp(op, "json") == 0) {
      ScrStr *text = scr_str_new(argbuf, arg_len);
      ScrDyn *d = scr_json_parse(text);
      scr_str_release(text);
      if (!d) {
        fprintf(stderr, "json parse failed: %.*s\n", (int)arg_len, argbuf);
        return 2;
      }
      result = scr_insp_dyn(d, 0, 2);
      scr_dyn_release(d);
    } else if (strcmp(op, "buffer") == 0) {
      ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)arg_len);
      memcpy(b->data, argbuf, arg_len);
      result = scr_insp_buffer(b);
      scr_bytes_release(b);
    } else {
      fprintf(stderr, "unknown op: %s\n", op);
      return 2;
    }
    check(op, argbuf, arg_len, result, expbuf, exp_len);
    scr_str_release(result);
  }
  fclose(f);
  /* Node's output budget (ctx.budget) belongs to one inspect call: a value
   * whose rendering spends it leaves the next top-level value's rendering
   * whole. */
  {
    size_t big = ((size_t)1 << 27) + 1;
    char *text = malloc(big);
    if (!text) return 2;
    memset(text, 'x', big);
    ScrStr *entry = scr_str_new(text, big);
    free(text);
    ScrStr *base = scr_str_new("", 0);
    ScrStr *open = scr_str_new("[", 1);
    ScrStr *close = scr_str_new("]", 1);
    scr_insp_gate(0, 2);
    scr_insp_begin(1);
    scr_insp_entry(entry, false);
    ScrStr *spent = scr_insp_end(base, open, close, 1, true, false);
    scr_str_release(spent);
    scr_str_release(entry);
    scr_str_release(base);
    scr_str_release(open);
    scr_str_release(close);
    static const char json[] = "[1,[2]]";
    static const char expected[] = "[ 1, [ 2 ] ]";
    ScrStr *source = scr_str_new(json, sizeof json - 1);
    ScrDyn *d = scr_json_parse(source);
    scr_str_release(source);
    ScrStr *after = scr_insp_dyn(d, 0, 2);
    scr_dyn_release(d);
    check("budget", json, sizeof json - 1, after, expected, sizeof expected - 1);
    scr_str_release(after);
  }
  fprintf(stderr, "%ld/%ld cases passed\n", total - failed, total);
  return failed ? 1 : 0;
}
