/* cstring probe, mode-selected by argv[1]:
 *   ok        — cstring parameters copy in (UTF-8, U+FFFD for malformed
 *               bytes), cstring results are NUL-terminated arena copies,
 *               and a cstring callback argument arrives NUL-terminated
 *   nullarg   — a NULL cstring parameter is the SC4012 host-contract trap
 *   nulresult — a result holding U+0000 traps instead of truncating
 *   nularg    — a callback argument holding U+0000 traps the same way
 */
#include <setjmp.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

extern void kc_init(void);
extern void kc_set_panic_sink(void (*fn)(void *, const uint8_t *, size_t, uint64_t), void *ctx);
extern void kc_collect(void);
extern int32_t kc_set_callback(const char *name, void (*fn)(void), void *ctx);
extern const char *kc_greet(const char *name);
extern double kc_length(const char *text);
extern double kc_echo(const char *text);
extern const char *kc_with_nul(void);
extern double kc_echo_nul(void);

static jmp_buf trap_jmp;

static void sink(void *ctx, const uint8_t *msg, size_t len, uint64_t addr) {
  (void)ctx; (void)addr;
  /* structured: 0x01 text 0x1F code 0x1F symbol */
  const uint8_t *p = msg + 1, *end = msg + len;
  const char *names[3] = {"text", "code", "symbol"};
  for (int field = 0; field < 3 && p <= end; field++) {
    const uint8_t *sep = memchr(p, 0x1f, (size_t)(end - p));
    const uint8_t *stop = sep != NULL ? sep : end;
    printf("%s=[%.*s]\n", names[field], (int)(stop - p), (const char *)p);
    if (sep == NULL) break;
    p = sep + 1;
  }
  longjmp(trap_jmp, 1);
}

static void on_log(void *ctx, const char *text, double n) {
  (void)ctx;
  printf("log: %s (strlen %zu, n %.0f)\n", text, strlen(text), n);
}

int main(int argc, char **argv) {
  const char *mode = argc > 1 ? argv[1] : "ok";
  kc_set_panic_sink(sink, NULL);
  kc_init();
  printf("register: %d\n", (int)kc_set_callback("log", (void (*)(void))on_log, NULL));
  if (setjmp(trap_jmp) != 0) {
    printf("trapped\n");
    return 0;
  }
  if (strcmp(mode, "ok") == 0) {
    const char *g = kc_greet("w\xC3\xB6rld");
    printf("greet: %s (strlen %zu)\n", g, strlen(g));
    printf("length ascii: %.0f\n", kc_length("abc"));
    printf("length utf8: %.0f\n", kc_length("caf\xC3\xA9"));
    printf("length malformed: %.0f\n", kc_length("a\xFF" "b"));
    printf("length empty: %.0f\n", kc_length(""));
    printf("echo: %.0f\n", kc_echo("quiet"));
    kc_collect();
    printf("done\n");
  } else if (strcmp(mode, "nullarg") == 0) {
    kc_length(NULL);
    printf("UNREACHABLE\n");
  } else if (strcmp(mode, "nulresult") == 0) {
    kc_with_nul();
    printf("UNREACHABLE\n");
  } else if (strcmp(mode, "nularg") == 0) {
    kc_echo_nul();
    printf("UNREACHABLE\n");
  }
  return 0;
}
