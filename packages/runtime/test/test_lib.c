/* Oracle test for scr_lib.c (process + sync fs). Run by lib.test.ts with a
 * fresh scratch directory as argv[1]; built with ASan + the RC audit, so a
 * clean exit also proves the library's ownership contract (borrowed args,
 * +1 results, interned argv/platform released by the atexit cleanup).
 *
 * Error-message fidelity is checked HERE because compiled programs cannot
 * observe it: the supported catch form is bindingless and uncaught stderr
 * is not compared by the differential harness. Each expected failure is
 * routed through scr_exc_print_uncaught(), and lib.test.ts asserts the
 * exact "Uncaught <ERRNO>: <text>, <syscall> '<path>'" stderr lines.
 */
#include "scr_runtime.h"
#include "scr_win_stats.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static int checks = 0;
static int failures = 0;

static void check(bool ok, const char *name) {
  checks++;
  if (!ok) {
    failures++;
    printf("FAIL %s\n", name);
  }
}

static ScrStr *S(const char *s) { return scr_str_new(s, strlen(s)); }

static bool str_is(const ScrStr *s, const char *want) {
  return s && s->len == strlen(want) && memcmp(s->data, want, s->len) == 0;
}

/* Perform-op helpers so every expected failure follows one shape: op runs,
 * the exception must be pending, and the payload prints to stderr (which
 * releases it and clears the cell). */
static void expect_pending(const char *name) {
  check(scr_exc_pending(), name);
  if (scr_exc_pending()) scr_exc_print_uncaught();
}

int main(int argc, char **argv) {
  scr_init();
  scr_lib_init(argc, argv);
  if (argc < 2) {
    fputs("usage: test_lib <scratch-dir>\n", stderr);
    return 2;
  }
  const char *dir = argv[1];
  char pb[4096];
  ScrStr *p; /* current path operand */
  ScrStr *t;

  /* IO_REPARSE_TAG_MOUNT_POINT is shared by directory junctions and volume
   * mount points. Pin the libuv-compatible payload distinction without
   * requiring this portable unit test to provision a Windows volume. */
  static const uint16_t junction_root[] = {'\\', '?', '?', '\\', 'C', ':'};
  static const uint16_t junction_path[] = {
    '\\', '?', '?', '\\', 'd', ':', '\\', 'w', 'o', 'r', 'k'
  };
  static const uint16_t volume_mount[] = {
    '\\', '?', '?', '\\', 'V', 'o', 'l', 'u', 'm', 'e', '{', '1', '}', '\\'
  };
  static const uint16_t drive_relative[] = {
    '\\', '?', '?', '\\', 'C', ':', 'r', 'e', 'l'
  };
  static const uint16_t unc_mount[] = {
    '\\', '?', '?', '\\', 'U', 'N', 'C', '\\', 's', 'h', 'a', 'r', 'e'
  };
  check(scr_win_stats_mount_target_is_junction(
          junction_root, sizeof junction_root / sizeof junction_root[0]),
        "drive-root mount payload is a junction");
  check(scr_win_stats_mount_target_is_junction(
          junction_path, sizeof junction_path / sizeof junction_path[0]),
        "drive-path mount payload is a junction");
  check(!scr_win_stats_mount_target_is_junction(
          volume_mount, sizeof volume_mount / sizeof volume_mount[0]),
        "volume mount payload is followed");
  check(!scr_win_stats_mount_target_is_junction(
          drive_relative, sizeof drive_relative / sizeof drive_relative[0]),
        "drive-relative mount payload is followed");
  check(!scr_win_stats_mount_target_is_junction(
          unc_mount, sizeof unc_mount / sizeof unc_mount[0]),
        "UNC mount payload is followed");

  /* process.argv: one interned array — identity, shape, contents. */
  ScrArr *a1 = scr_process_argv();
  ScrArr *a2 = scr_process_argv();
  check(a1 == a2, "argv interned identity");
  check(scr_arr_len(a1) == (double)argc + 1, "argv length = argc + 1");
  t = scr_arr_get_ref(a1, 0);
  check(str_is(t, "scriptc"), "argv[0] is 'scriptc'");
  scr_str_release(t);
  t = scr_arr_get_ref(a1, 2);
  check(str_is(t, dir), "argv[2] is the first real argument");
  scr_str_release(t);
  scr_arr_release(a1);
  scr_arr_release(a2);

  /* process.platform: interned, matches the compile-time target. */
  ScrStr *pl1 = scr_process_platform();
  ScrStr *pl2 = scr_process_platform();
  check(pl1 == pl2, "platform interned identity");
#if defined(__APPLE__)
  check(str_is(pl1, "darwin"), "platform is darwin");
#elif defined(__linux__)
  check(str_is(pl1, "linux"), "platform is linux");
#endif
  scr_str_release(pl1);
  scr_str_release(pl2);

  /* Historical local-mean offsets include seconds in the timezone data,
   * while Date#getTimezoneOffset exposes whole minutes. */
  setenv("TZ", "America/Chicago", 1);
  tzset();
  double historical_offset = scr_date_get_timezone_offset(-5364662400000.0);
  check(historical_offset == trunc(historical_offset),
        "historical timezone offset truncates to whole minutes");

  /* process.cwd: fresh absolute path. */
  t = scr_process_cwd();
  check(t->len > 0 && t->data[0] == '/', "cwd is absolute");
  scr_str_release(t);

  /* process.env: +1 fresh string when set, NULL when absent, never a
   * throw (the compiler builds the string|undefined union from this). */
  setenv("SCR_TEST_ENV_VAR", "libtest", 1);
  p = S("SCR_TEST_ENV_VAR");
  t = scr_env_get(p);
  check(str_is(t, "libtest"), "env get returns the set value");
  scr_str_release(t);
  scr_str_release(p);
  p = S("SCR_TEST_ENV_VAR_DEFINITELY_NOT_SET");
  check(scr_env_get(p) == NULL, "absent env var is NULL");
  check(!scr_exc_pending(), "env get never throws");
  scr_str_release(p);

  /* write → exists → read roundtrip (unicode bytes), then append. */
  snprintf(pb, sizeof pb, "%s/a.txt", dir);
  p = S(pb);
  ScrStr *content = S("h\xc3\xa9llo \xf0\x9f\x8c\x8d\n"); /* "héllo 🌍\n" */
  scr_fs_write_file(p, content);
  check(!scr_exc_pending(), "write succeeds");
  check(scr_fs_exists(p), "exists after write");
  t = scr_fs_read_file(p);
  check(!scr_exc_pending(), "read succeeds");
  check(t && t->len == content->len && memcmp(t->data, content->data, t->len) == 0,
        "read returns written bytes");
  scr_str_release(t);
  ScrStr *more = S("more");
  scr_fs_append_file(p, more);
  check(!scr_exc_pending(), "append succeeds");
  t = scr_fs_read_file(p);
  check(t && t->len == content->len + 4, "append extends the file");
  scr_str_release(t);
  scr_str_release(more);
  scr_str_release(content);

  /* readdir membership, then rm the file. */
  ScrStr *dirs = S(dir);
  ScrArr *names = scr_fs_readdir(dirs);
  check(!scr_exc_pending(), "readdir succeeds");
  t = S("a.txt");
  check(scr_arr_includes_ref(names, t), "readdir lists a.txt");
  scr_str_release(t);
  scr_arr_release(names);
  scr_fs_rm(p);
  check(!scr_exc_pending(), "rm succeeds");
  check(!scr_fs_exists(p), "gone after rm");
  scr_str_release(p);

  /* mkdir → rmdir roundtrip. */
  snprintf(pb, sizeof pb, "%s/sub", dir);
  p = S(pb);
  scr_fs_mkdir(p);
  check(!scr_exc_pending(), "mkdir succeeds");
  check(scr_fs_exists(p), "dir exists");

  /* Expected failures, in a fixed order lib.test.ts asserts on stderr. */
  /* 1: read of a missing file → ENOENT open */
  snprintf(pb, sizeof pb, "%s/missing.txt", dir);
  t = S(pb);
  check(!scr_fs_exists(t), "existsSync false, no throw");
  check(!scr_exc_pending(), "existsSync never throws");
  ScrStr *dummy = scr_fs_read_file(t);
  check(dummy == NULL, "failed read returns dummy NULL");
  expect_pending("read missing throws");
  /* 2: rm of a missing path → ENOENT lstat */
  scr_fs_rm(t);
  expect_pending("rm missing throws");
  /* 3: rmdir of a missing path → ENOENT rmdir */
  scr_fs_rmdir(t);
  expect_pending("rmdir missing throws");
  /* 4: readdir of a missing path → ENOENT scandir */
  names = scr_fs_readdir(t);
  check(names == NULL, "failed readdir returns dummy NULL");
  expect_pending("readdir missing throws");
  scr_str_release(t);
  /* 5: mkdir of an existing path → EEXIST mkdir */
  scr_fs_mkdir(p);
  expect_pending("mkdir existing throws");
  /* 6: mkdir under a missing parent → ENOENT mkdir */
  snprintf(pb, sizeof pb, "%s/nope/deep", dir);
  t = S(pb);
  scr_fs_mkdir(t);
  expect_pending("mkdir missing parent throws");
  scr_str_release(t);
  /* 7: rm of a directory → EISDIR rm */
  scr_fs_rm(p);
  expect_pending("rm of a directory throws");

  scr_fs_rmdir(p);
  check(!scr_exc_pending(), "rmdir succeeds");
  scr_str_release(p);
  scr_str_release(dirs);

  printf("%d/%d checks passed\n", checks - failures, checks);
  return failures ? 1 : 0;
}
