/* Windows string-conversion oracle for scr_lib.c's process surface (run by
 * win-ansi.test.ts on a Windows host, built with zig cc like the release
 * lane). Every string the process surface hands to or takes from Win32 goes
 * through UTF-16: process.env, os.tmpdir(), os.userInfo().username, and
 * process.execPath. The ANSI (A) forms would spell non-ASCII text in the
 * active code page, so this test drives the conversions with text that a
 * CP932/CP1251 machine cannot represent in its ANSI page, and checks the
 * bytes the runtime hands back are the exact UTF-8 the caller wrote.
 */
#include "scr_runtime.h"

#include <stdio.h>
#include <string.h>

static int failures = 0;
static int checks = 0;

static void check(bool ok, const char *name) {
  checks++;
  if (!ok) {
    failures++;
    printf("FAIL %s\n", name);
  }
}

static ScrStr *S(const char *s) { return scr_str_new(s, strlen(s)); }

/* Strict UTF-8 validation: rejects overlongs, surrogates and truncated
 * sequences. The conversions must produce well-formed UTF-8, not bytes that
 * merely look like the source on the machine that wrote them. */
static bool utf8_valid(const char *text, size_t len) {
  size_t i = 0;
  while (i < len) {
    unsigned char c = (unsigned char)text[i];
    size_t extra;
    unsigned minimum;
    unsigned cp;
    if (c < 0x80) {
      i++;
      continue;
    } else if ((c & 0xE0) == 0xC0) {
      extra = 1;
      minimum = 0x80;
      cp = c & 0x1F;
    } else if ((c & 0xF0) == 0xE0) {
      extra = 2;
      minimum = 0x800;
      cp = c & 0x0F;
    } else if ((c & 0xF8) == 0xF0) {
      extra = 3;
      minimum = 0x10000;
      cp = c & 0x07;
    } else {
      return false;
    }
    if (i + extra >= len) return false;
    for (size_t k = 1; k <= extra; k++) {
      unsigned char next = (unsigned char)text[i + k];
      if ((next & 0xC0) != 0x80) return false;
      cp = (cp << 6) | (next & 0x3F);
    }
    if (cp < minimum || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return false;
    i += extra + 1;
  }
  return true;
}

static bool str_is(const ScrStr *s, const char *want) {
  return s && s->len == strlen(want) && memcmp(s->data, want, s->len) == 0;
}

/* U+30C6 U+30B9 U+30C8 ("テスト") — three code points a CP932 page does
 * spell differently from UTF-8, and no ASCII fallback exists. */
static const char kName[] = "\xE3\x83\x86\xE3\x82\xB9\xE3\x83\x88";
/* U+3053 U+3093 U+306B U+3061 U+306F U+4E16 U+754C U+1F30F
 * ("こんにちは世界🌏") — BMP text plus one astral code point (a surrogate
 * pair in UTF-16). */
static const char kValue[] =
    "\xE3\x81\x93\xE3\x82\x93\xE3\x81\xAB\xE3\x81\xA1\xE3\x81\xAF\xE4\xB8\x96\xE7\x95\x8C\xF0\x9F\x8C\x8F";

static void test_env_roundtrip(void) {
  ScrStr *name = S(kName);
  ScrStr *value = S(kValue);
  scr_env_set(name, value);

  ScrStr *read = scr_env_get(name);
  check(str_is(read, kValue), "env value round-trips UTF-8 through UTF-16");
  check(read && utf8_valid(read->data, read->len), "env value reads back as well-formed UTF-8");
  scr_str_release(read);

  /* The enumeration path reads the whole UTF-16 block. */
  ScrArr *pairs = scr_env_pairs();
  bool found = false;
  for (double i = 0; i + 1 < scr_arr_len(pairs); i += 2) {
    ScrStr *key = (ScrStr *)scr_arr_get_ref(pairs, i);
    ScrStr *entry = (ScrStr *)scr_arr_get_ref(pairs, i + 1);
    if (key && entry && key->len == strlen(kName) && memcmp(key->data, kName, key->len) == 0) {
      found = true;
      check(entry->len == strlen(kValue) && memcmp(entry->data, kValue, entry->len) == 0,
            "environment block carries the UTF-8 value");
    }
    scr_str_release(key);
    scr_str_release(entry);
  }
  scr_arr_release(pairs);
  check(found, "environment block carries the UTF-8 name");

  scr_env_unset(name);
  ScrStr *gone = scr_env_get(name);
  check(gone == NULL, "env delete removes the UTF-8 name");
  scr_str_release(gone);
  scr_str_release(name);
  scr_str_release(value);

  /* A present-but-empty value stays present and empty, as in Node: the
   * wide lookup reports zero UTF-16 units for it, which is not the same as
   * ERROR_ENVVAR_NOT_FOUND. */
  ScrStr *marker = S("SCRIPTC_WIN_ANSI_EMPTY");
  ScrStr *empty = S("");
  scr_env_set(marker, empty);
  ScrStr *empty_read = scr_env_get(marker);
  check(empty_read && empty_read->len == 0, "empty env value stays present and empty");
  scr_str_release(empty_read);
  scr_env_unset(marker);
  ScrStr *marker_gone = scr_env_get(marker);
  check(marker_gone == NULL, "empty env var deletes");
  scr_str_release(marker_gone);
  scr_str_release(marker);
  scr_str_release(empty);
}

static void test_process_paths(void) {
  ScrStr *exe = scr_process_exec_path();
  check(exe && exe->len > 0, "execPath is non-empty");
  check(exe && utf8_valid(exe->data, exe->len), "execPath is well-formed UTF-8");
  check(exe && memchr(exe->data, '\0', exe->len) == NULL, "execPath has no embedded NUL");
  scr_str_release(exe);

  ScrStr *tmp = scr_os_tmpdir();
  check(tmp && tmp->len > 0, "os.tmpdir is non-empty");
  check(tmp && utf8_valid(tmp->data, tmp->len), "os.tmpdir is well-formed UTF-8");
  scr_str_release(tmp);

  ScrStr *user = scr_os_user_name();
  check(user && user->len > 0, "os.userInfo().username is non-empty");
  check(user && utf8_valid(user->data, user->len), "os.userInfo().username is well-formed UTF-8");
  scr_str_release(user);
}

int main(int argc, char **argv) {
  scr_init();
  scr_lib_init(argc, argv);
  test_env_roundtrip();
  test_process_paths();
  printf("%d checks, %d failures\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
