/* The OS-facing half of the typed-array/Buffer runtime: fs Buffer reads/
 * writes (scr_lib.c's throw formatting), the fs/promises bytes form
 * (scr_async.c's settled-promise minting), crypto.randomBytes, and the
 * process stream Buffer writes. Split from scr_bytes.c so the pure bytes
 * core links without the lib/async runtimes (the runtime unit tests link
 * exact source lists). */
#include "scr_runtime.h"

#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#ifdef __APPLE__
#include <sys/stat.h> /* lchmod(2) — the fs.lchmodSync ladder's real tail */
#endif

static void scr_bytes_io_oom(void) {
  scr_trap("scriptc: out of memory\n");
}

/* ── fs (the Buffer forms of scr_lib.c's utf8 pair) ────────────────────── */

ScrBytes *scr_fs_read_file_bytes(ScrStr *path) {
  FILE *f = fopen(path->data, "rb");
  if (!f) {
    scr_fs_throw(errno, "open", path);
    return NULL;
  }
  size_t cap = 4096, len = 0;
  uint8_t *buf = malloc(cap);
  if (!buf) scr_bytes_io_oom();
  for (;;) {
    if (cap - len < 2048) {
      cap *= 2;
      uint8_t *grown = realloc(buf, cap);
      if (!grown) scr_bytes_io_oom();
      buf = grown;
    }
    size_t n = fread(buf + len, 1, cap - len, f);
    len += n;
    if (n == 0) break;
  }
  if (ferror(f)) {
    int e = errno;
    fclose(f);
    free(buf);
    scr_fs_throw(e, "read", path);
    return NULL;
  }
  fclose(f);
  ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)len);
  memcpy(b->data, buf, len);
  free(buf);
  return b;
}

/* readFileSync's runtime-encoding form (a JS helper's untyped `enc`
 * parameter — test/common fixtures.js): undefined/null answer a Buffer,
 * utf8 answers a string, Node's other real encodings meet the loud
 * not-supported ladder, unknown names throw ERR_UNKNOWN_ENCODING, and an
 * options object dispatches on its `encoding` member (Node's form). +1
 * dyn value, or NULL with the exception pending. */
ScrDyn *scr_fs_read_file_sync_dyn(ScrStr *path, const ScrDyn *enc) {
  if (enc->kind == SCR_DYN_OBJ) {
    ScrDyn *ev = scr_dyn_obj_get((ScrDyn *)enc, "encoding", 8); /* borrowed */
    return scr_fs_read_file_sync_dyn(path, ev ? ev : scr_dyn_undefined());
  }
  if (enc->kind == SCR_DYN_UNDEF || enc->kind == SCR_DYN_NULL) {
    ScrBytes *b = scr_fs_read_file_bytes(path);
    if (!b) return NULL;
    ScrDyn *d = scr_dyn_new_buffer_copy(b);
    scr_bytes_release(b);
    return d;
  }
  if (enc->kind == SCR_DYN_STR) {
    const ScrStr *e = enc->v.str;
    if ((e->len == 4 && memcmp(e->data, "utf8", 4) == 0) ||
        (e->len == 5 && memcmp(e->data, "utf-8", 5) == 0)) {
      ScrStr *text = scr_fs_read_file(path);
      if (!text) return NULL;
      ScrDyn *d = scr_dyn_new_str(text);
      scr_str_release(text);
      return d;
    }
    static const char *const known[] = { "ascii", "latin1", "binary", "base64",
      "base64url", "hex", "ucs2", "ucs-2", "utf16le", "utf-16le", NULL };
    for (size_t i = 0; known[i]; i++) {
      if (e->len == strlen(known[i]) && memcmp(e->data, known[i], e->len) == 0) {
        char msg[128];
        int n = snprintf(msg, sizeof msg,
                         "readFileSync with encoding '%s' is not supported yet (only 'utf8' and Buffer reads here)",
                         known[i]);
        scr_throw_error_msg(SCR_ERR_ERROR, msg, (size_t)n);
        return NULL;
      }
    }
    char msg[128];
    int n = snprintf(msg, sizeof msg, "Unknown encoding: %.*s",
                     (int)(e->len < 64 ? e->len : 64), e->data);
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)n, "ERR_UNKNOWN_ENCODING");
    return NULL;
  }
  {
    /* Kind rendering stays local: scr_dyn_specific_type lives in the
     * net/emitter-gated handle unit and this one links with bare fs. */
    const char *msg = "The \"options\" argument must be of type string or an instance of Object";
    scr_throw_error_msg_code(SCR_ERR_TYPE, msg, strlen(msg), "ERR_INVALID_ARG_TYPE");
    return NULL;
  }
}

void scr_fs_write_file_bytes(ScrStr *path, const ScrBytes *data) {
  FILE *f = fopen(path->data, "wb");
  if (!f) {
    scr_fs_throw(errno, "open", path);
    return;
  }
  size_t n = data->len * scr_bytes_elem_size(data->elem);
  if (n > 0 && fwrite(data->data, 1, n, f) != n) {
    int e = errno;
    fclose(f);
    scr_fs_throw(e, "write", path);
    return;
  }
  if (fclose(f) != 0) scr_fs_throw(errno, "close", path);
}

ScrPromise *scr_fsp_read_file_bytes(ScrStr *path) {
  ScrBytes *b = scr_fs_read_file_bytes(path);
  return scr_promise_settled_ref(b, &scr_bytes_retain_v, &scr_bytes_release_v, NULL);
}

/* ── crypto.randomBytes → a real Buffer ────────────────────────────────── */

ScrBytes *scr_crypto_random_bytes(double n) {
  if (!(n >= 0 && n <= 2147483647)) {
    char num[32];
    size_t numlen = scr_f64_to_str(n, num);
    char msg[128];
    int mlen = snprintf(
        msg, sizeof msg,
        "The value of \"size\" is out of range. It must be >= 0 && <= 2147483647. Received %.*s",
        (int)numlen, num);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)mlen, "ERR_OUT_OF_RANGE");
    return NULL;
  }
  ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, n);
  if (b->len > 0) arc4random_buf(b->data, b->len);
  return b;
}

/* ── process.stdout/stderr.write(buf) ──────────────────────────────────── */

bool scr_process_stdout_write_bytes(const ScrBytes *b, const ScrStr *encoding) {
  (void)encoding;
  scr_stdio_write(1, b->data, b->len * scr_bytes_elem_size(b->elem));
  return true;
}

bool scr_process_stderr_write_bytes(const ScrBytes *b, const ScrStr *encoding) {
  (void)encoding;
  scr_stdio_write(2, b->data, b->len * scr_bytes_elem_size(b->elem));
  return true;
}

/* ── the checked-dynamic Buffer compare/equals validators ──────────────
 * Node's argument ladders for buf.equals / buf.compare / Buffer.compare
 * over dyn-boxed arguments (the invalid-input probes: string needles,
 * '0' offsets, null/object range args). A well-typed dyn still computes
 * the real answer — validation, not a constant fence. */

/* A bytes payload or the API's own ERR_INVALID_ARG_TYPE (borrowed). */
static ScrBytes *scr_bytes_chk_u8(const ScrDyn *d, const char *argname) {
  if (d->kind != SCR_DYN_BYTES) {
    scr_dyn_arg_type_fail(argname, "an instance of Buffer or Uint8Array", d);
    return NULL;
  }
  return d->v.bytes;
}

double scr_buffer_compare_chk(const ScrDyn *a, const ScrDyn *b) {
  ScrBytes *b1 = scr_bytes_chk_u8(a, "buf1");
  if (!b1) return 0;
  ScrBytes *b2 = scr_bytes_chk_u8(b, "buf2");
  if (!b2) return 0;
  return scr_bytes_compare(b1, b2, 0, 0, 0, 0, 0);
}

bool scr_bytes_equals_chk(const ScrBytes *recv, const ScrDyn *other) {
  ScrBytes *o = scr_bytes_chk_u8(other, "otherBuffer");
  if (!o) return false;
  return scr_bytes_equals(recv, o);
}

/* One offset slot: undefined takes the Node default, non-numbers throw
 * ERR_INVALID_ARG_TYPE "of type number", numbers run validateOffset. */
static bool scr_bytes_chk_off(const ScrDyn *d, const char *name, double max,
                              double dflt, double *out) {
  if (d->kind == SCR_DYN_UNDEF) {
    *out = dflt;
    return true;
  }
  if (d->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail(name, "of type number", d);
    return false;
  }
  *out = d->v.num;
  return scr_bytes_validate_off(name, *out, max);
}

double scr_bytes_compare_chk(const ScrBytes *src, const ScrDyn *target,
                             const ScrDyn *ts, const ScrDyn *te,
                             const ScrDyn *ss, const ScrDyn *se) {
  ScrBytes *t = scr_bytes_chk_u8(target, "target");
  if (!t) return 0;
  double tsv, tev, ssv, sev;
  if (!scr_bytes_chk_off(ts, "targetStart", 9007199254740991.0, 0, &tsv)) return 0;
  if (!scr_bytes_chk_off(te, "targetEnd", (double)t->len, (double)t->len, &tev)) return 0;
  if (!scr_bytes_chk_off(ss, "sourceStart", 9007199254740991.0, 0, &ssv)) return 0;
  if (!scr_bytes_chk_off(se, "sourceEnd", (double)src->len, (double)src->len, &sev)) return 0;
  /* Every slot validated or defaulted above; nargs 4 revalidates the
   * now-known-good numbers (a no-op) and keeps one comparison core. */
  return scr_bytes_compare(src, t, 4, tsv, tev, ssv, sev);
}

/* new Buffer(number, encoding) — the deprecated ctor's string arm with a
 * non-string first argument: Node's exact ERR_INVALID_ARG_TYPE (the
 * throwing path never fires DEP0005, so compiled silence matches). */
ScrBytes *scr_buffer_new_string_fail(const ScrDyn *got) {
  scr_dyn_arg_type_fail("string", "of type string", got);
  return NULL;
}

/* fs._toUnixTimestamp — the seconds coercion the utimes family runs on
 * its time arguments (fs.js's toUnixTimestamp, underscore-exported):
 * numeric STRINGS pass ToNumber's loose-equality gate (+time == time —
 * whitespace-only strings answer 0), finite numbers pass (negatives
 * answer now/1000, Node's "past times" shape), everything else throws
 * Node's exact ERR_INVALID_ARG_TYPE. Borrowed; the throw is pending on
 * the dummy 0 return. */
double scr_fs_to_unix_timestamp(const ScrDyn *t) {
  if (t->kind == SCR_DYN_STR) {
    double n = scr_string_to_number(t->v.str);
    /* +time == time: NaN fails; every parsed number loosely equals its
     * own source string by construction of ToNumber. */
    if (n == n) return n;
  }
  if (t->kind == SCR_DYN_NUM && isfinite(t->v.num)) {
    if (t->v.num < 0) {
      struct timespec ts;
      clock_gettime(CLOCK_REALTIME, &ts);
      return ((double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6) / 1000.0;
    }
    return t->v.num;
  }
  scr_dyn_arg_type_fail("time", "an instance of Date or an Time in seconds", t);
  return 0;
}

/* ── the fs argument-validation ladders (checked-dynamic lane) ─────────
 * Each fs.*Chk libCall replicates its API's Node-order validation over
 * dyn values and throws Node's exact typed errors; when every validation
 * passes, the honest tail runs — the real operation where one exists
 * (mkdtempSync, lchmodSync on macOS), the compiler-rendered SC2020 fence
 * otherwise (scr_throw_lowering_fence). All arguments borrowed. */

static bool scr_fs_dyn_absent(const ScrDyn *v) {
  return v->kind == SCR_DYN_UNDEF || v->kind == SCR_DYN_NULL;
}

static bool scr_fs_str_is(const ScrStr *s, const char *lit) {
  size_t n = strlen(lit);
  return s->len == n && memcmp(s->data, lit, n) == 0;
}

/* Node's maybeCallback/validateFunction over a callback slot. */
static bool scr_fs_cb_chk(const ScrDyn *cb, const char *name) {
  if (cb->kind == SCR_DYN_FUNC) return true;
  scr_dyn_arg_type_fail(name, "of type function", cb);
  return false;
}

/* getValidatedPath: strings and Buffers pass (URL instances never reach
 * these ladders — the checked-dynamic tree has no URL kind here, and Node would accept
 * only file: URLs anyway). */
static bool scr_fs_path_chk(const ScrDyn *p, const char *name) {
  if (p->kind == SCR_DYN_STR || p->kind == SCR_DYN_BYTES) return true;
  scr_dyn_arg_type_fail(name, "of type string or an instance of Buffer or URL", p);
  return false;
}

/* assertEncoding over an options slot (a bare encoding string or an
 * options record's `encoding` member): Node throws ERR_INVALID_ARG_VALUE
 * for any truthy value Buffer.isEncoding rejects. */
static bool scr_fs_encoding_chk(const ScrDyn *opts) {
  const ScrDyn *enc = opts;
  if (opts->kind == SCR_DYN_OBJ) {
    enc = scr_dyn_obj_get(opts, "encoding", 8);
    if (enc == NULL) return true;
  }
  if (scr_fs_dyn_absent(enc)) return true;
  if (enc->kind == SCR_DYN_STR) {
    if (enc->v.str->len == 0) return true; /* falsy: assertEncoding's `encoding &&` gate */
    if (scr_bytes_is_encoding(enc->v.str)) return true;
  }
  if (enc->kind == SCR_DYN_BOOL && !enc->v.b) return true;
  if (enc->kind == SCR_DYN_NUM && enc->v.num == 0) return true;
  scr_dyn_arg_value_fail("encoding", "is invalid encoding", enc);
  return false;
}

/* parseFileMode: integers 0..2^32-1 pass, octal strings parse, and the
 * rest throw Node's exact ladder (validateUint32's wording). */
static bool scr_fs_mode_chk(const ScrDyn *m, const char *name) {
  if (m->kind == SCR_DYN_STR) {
    const ScrStr *s = m->v.str;
    bool octal = s->len > 0;
    for (size_t i = 0; octal && i < s->len; i++) {
      if (s->data[i] < '0' || s->data[i] > '7') octal = false;
    }
    if (octal) return true;
    scr_dyn_arg_value_fail(name, "must be a 32-bit unsigned integer or an octal string", m);
    return false;
  }
  if (m->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail(name, "of type number", m);
    return false;
  }
  double v = m->v.num;
  if (!(isfinite(v) && trunc(v) == v)) {
    char recv[48], msg[160];
    scr_num_received(v, recv);
    int len = snprintf(msg, sizeof msg,
                       "The value of \"%s\" is out of range. It must be an integer. Received %s",
                       name, recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return false;
  }
  if (v < 0 || v > 4294967295.0) {
    char recv[48], msg[160];
    scr_num_received(v, recv);
    int len = snprintf(msg, sizeof msg,
                       "The value of \"%s\" is out of range. It must be >= 0 && <= 4294967295. Received %s",
                       name, recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return false;
  }
  return true;
}

/* fs.exists(path, cb) — the REAL deprecated-API shape: the callback
 * validates synchronously (Node's one throwing arm), and the answer
 * arrives asynchronously through it — string/Buffer paths run the
 * existsSync probe at fire time, every other path kind answers `false`
 * (Node swallows getValidatedPath failures there). The loop-held timer
 * matches Node's I/O-completion timing closely enough for the
 * sequential CLI corpus. */
#ifndef SCR_LIB
static void scr_fs_exists_fire(ScrClosure *self) {
  ScrDyn *path = scr_box_get_ref(self->caps[0]); /* +1 */
  ScrDyn *cb = scr_box_get_ref(self->caps[1]);   /* +1 */
  bool ans = false;
  if (path->kind == SCR_DYN_STR) {
    ScrStr *p = scr_str_retain(path->v.str);
    ans = scr_fs_exists(p);
    scr_str_release(p);
  } else if (path->kind == SCR_DYN_BYTES) {
    ScrStr *p = scr_str_new((const char *)path->v.bytes->data, path->v.bytes->len);
    ans = scr_fs_exists(p);
    scr_str_release(p);
  }
  ScrDyn *arg = scr_dyn_new_bool(ans);
  ScrDyn *r = scr_dyn_call(cb, &arg, 1, "the fs.exists callback");
  scr_dyn_release(arg);
  scr_dyn_release(r);
  scr_dyn_release(path);
  scr_dyn_release(cb);
}
#endif

ScrDyn *scr_fs_exists_async(const ScrDyn *path, const ScrDyn *cb) {
  if (!scr_fs_cb_chk(cb, "cb")) return NULL;
  if (path->kind != SCR_DYN_STR && path->kind != SCR_DYN_BYTES) {
    /* Node's wart, kept exactly: a path getValidatedPath rejects answers
     * false through the callback SYNCHRONOUSLY (`return callback(false)`
     * in lib/fs.js exists). */
    ScrDyn *arg = scr_dyn_new_bool(false);
    ScrDyn *r = scr_dyn_call(cb, &arg, 1, "the fs.exists callback");
    scr_dyn_release(arg);
    scr_dyn_release(r);
    if (scr_exc_pending()) return NULL;
    return scr_dyn_retain(scr_dyn_undefined());
  }
#ifdef SCR_LIB
  /* Library links exclude the event-loop unit, and the compile-time scan
   * refuses the fs.exists surface (SC4005's family) — this arm exists
   * only so the TU links without scr_async. Unreachable by construction. */
  scr_trap("scriptc: internal error: fs.exists async fire reached in a library build — please report this");
  return NULL;
#else
  ScrClosure *clo = scr_closure_new((void *)scr_fs_exists_fire, 2);
  clo->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, NULL);
  scr_box_set_ref(clo->caps[0], scr_dyn_retain((ScrDyn *)path));
  clo->caps[1] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, NULL);
  scr_box_set_ref(clo->caps[1], scr_dyn_retain((ScrDyn *)cb));
  scr_set_timeout(clo, 0);
  return scr_dyn_retain(scr_dyn_undefined());
#endif
}

/* fs.mkdtemp(prefix, options?, cb): callback first (makeCallback), then
 * the prefix (getValidatedPath's 'prefix' slot); the async op fences. */
void scr_fs_mkdtemp_chk(const ScrDyn *prefix, const ScrDyn *cb, const ScrStr *fence) {
  if (!scr_fs_cb_chk(cb, "cb")) return;
  if (!scr_fs_path_chk(prefix, "prefix")) return;
  scr_throw_lowering_fence(fence);
}

/* fs.mkdtempSync(prefix, options?): prefix validates (Node's 'prefix'
 * slot), the options walk accepts only shapes that leave utf8 semantics
 * (absent/empty records, utf8 spellings — invalid encodings throw the
 * assertEncoding ladder, other effectful options fence), then the REAL
 * mkdtemp runs. +1 result or NULL with the exception pending. */
ScrStr *scr_fs_mkdtemp_sync_chk(const ScrDyn *prefix, const ScrDyn *opts, const ScrStr *fence) {
  if (!scr_fs_path_chk(prefix, "prefix")) return NULL;
  if (!scr_fs_encoding_chk(opts)) return NULL;
  bool utf8 = true;
  if (opts->kind == SCR_DYN_OBJ) {
    for (size_t i = 0; i < opts->v.obj.len; i++) {
      const ScrDynEntry *e = &opts->v.obj.entries[i];
      if (scr_fs_dyn_absent(e->value)) continue;
      if (strcmp(e->key, "encoding") == 0) {
        const ScrDyn *enc = e->value;
        if (!(enc->kind == SCR_DYN_STR &&
              (scr_fs_str_is(enc->v.str, "utf8") || scr_fs_str_is(enc->v.str, "utf-8")))) {
          utf8 = false;
        }
        continue;
      }
      utf8 = false; /* an unmodeled effectful option */
    }
  } else if (opts->kind == SCR_DYN_STR) {
    utf8 = scr_fs_str_is(opts->v.str, "utf8") || scr_fs_str_is(opts->v.str, "utf-8");
  } else if (!scr_fs_dyn_absent(opts)) {
    utf8 = false;
  }
  if (!utf8 || prefix->kind != SCR_DYN_STR) {
    scr_throw_lowering_fence(fence);
    return NULL;
  }
  ScrStr *p = scr_str_retain(prefix->v.str);
  ScrStr *r = scr_fs_mkdtemp(p);
  scr_str_release(p);
  return r;
}

/* fs.readFile(path, options?, cb): Node's order — the callback
 * (maybeCallback), the options walk's assertEncoding, then the path;
 * the async read itself fences. */
void scr_fs_read_file_chk(const ScrDyn *path, const ScrDyn *opts, const ScrDyn *cb,
                          const ScrStr *fence) {
  if (!scr_fs_cb_chk(cb, "cb")) return;
  if (!scr_fs_encoding_chk(opts)) return;
  if (!scr_fs_path_chk(path, "path")) return;
  scr_throw_lowering_fence(fence);
}

/* fs.opendirSync(path, options?): getValidatedPath, then getOptions'
 * assertEncoding; the Dir machinery fences. */
void scr_fs_opendir_chk(const ScrDyn *path, const ScrDyn *opts, const ScrStr *fence) {
  if (!scr_fs_path_chk(path, "path")) return;
  if (!scr_fs_encoding_chk(opts)) return;
  scr_throw_lowering_fence(fence);
}

/* fs.watchFile(path, options?, listener): the path first, the listener's
 * function check second (Node's watchFile order); real watching fences. */
void scr_fs_watch_file_chk(const ScrDyn *path, const ScrDyn *listener, const ScrStr *fence) {
  if (!scr_fs_path_chk(path, "path")) return;
  if (listener->kind != SCR_DYN_FUNC) {
    scr_dyn_arg_type_fail("listener", "of type function", listener);
    return;
  }
  scr_throw_lowering_fence(fence);
}

/* fs.lchmod / lchmodSync / fs.promises.lchmod — macOS-only in Node (the
 * callback/sync pair is not even exported elsewhere, so non-APPLE builds
 * answer the not-a-function TypeError; the promise form rejects
 * ERR_METHOD_NOT_IMPLEMENTED, Node's own linux shape). On macOS the
 * validation ladder runs in Node's order and the real lchmod(2) applies
 * where an operation survives it. */
static bool scr_fs_lchmod_defined(const char *api) {
#ifdef __APPLE__
  (void)api;
  return true;
#else
  char msg[64];
  int len = snprintf(msg, sizeof msg, "%s is not a function", api);
  scr_throw_error_msg(SCR_ERR_TYPE, msg, (size_t)len);
  return false;
#endif
}

void scr_fs_lchmod_chk(const ScrDyn *path, const ScrDyn *mode, const ScrDyn *cb,
                       const ScrStr *fence) {
  if (!scr_fs_lchmod_defined("fs.lchmod")) return;
  if (!scr_fs_cb_chk(cb, "cb")) return;
  if (!scr_fs_path_chk(path, "path")) return;
  if (!scr_fs_mode_chk(mode, "mode")) return;
  scr_throw_lowering_fence(fence); /* the async op + callback dispatch */
}

#ifdef __APPLE__
static void scr_fs_lchmod_apply(const ScrDyn *path, const ScrDyn *mode) {
  ScrStr *p = path->kind == SCR_DYN_STR ? scr_str_retain(path->v.str)
                                        : scr_str_new((const char *)path->v.bytes->data, path->v.bytes->len);
  double m = mode->kind == SCR_DYN_NUM ? mode->v.num : (double)strtol(mode->v.str->data, NULL, 8);
  if (lchmod(p->data, (mode_t)m) != 0) scr_fs_throw(errno, "lchmod", p);
  scr_str_release(p);
}
#endif

/* Answers the dyn undefined (+1) on success — lchmodSync's JS value, so
 * return-position uses lower; NULL with the exception pending. */
ScrDyn *scr_fs_lchmod_sync_chk(const ScrDyn *path, const ScrDyn *mode) {
  if (!scr_fs_lchmod_defined("fs.lchmodSync")) return NULL;
  if (!scr_fs_path_chk(path, "path")) return NULL;
  if (!scr_fs_mode_chk(mode, "mode")) return NULL;
#ifdef __APPLE__
  scr_fs_lchmod_apply(path, mode);
  if (scr_exc_pending()) return NULL;
#endif
  return scr_dyn_retain(scr_dyn_undefined());
}

ScrPromise *scr_fsp_lchmod_chk(const ScrDyn *path, const ScrDyn *mode) {
#ifndef __APPLE__
  (void)path;
  (void)mode;
  static const char ni[] = "The lchmod() method is not implemented";
  scr_throw_error_msg_code(SCR_ERR_ERROR, ni, sizeof ni - 1, "ERR_METHOD_NOT_IMPLEMENTED");
  return scr_promise_settled_void();
#else
  if (scr_fs_path_chk(path, "path") && scr_fs_mode_chk(mode, "mode")) {
    scr_fs_lchmod_apply(path, mode);
  }
  return scr_promise_settled_void();
#endif
}

/* fs.read(fd, buffer, offset, length, position, cb) — the full argument
 * ladder in Node's order (buffer, fd, offset, length, position); the
 * async read fences. Bounds follow lib/fs.js read(): offset within the
 * buffer, length within buffer - offset. */
static bool scr_fs_int_range_chk(const ScrDyn *v, const char *name, double min, double max,
                                 const char *range) {
  if (v->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail(name, "of type number", v);
    return false;
  }
  double n = v->v.num;
  char recv[48], msg[192];
  if (!(isfinite(n) && trunc(n) == n)) {
    scr_num_received(n, recv);
    int len = snprintf(msg, sizeof msg,
                       "The value of \"%s\" is out of range. It must be an integer. Received %s",
                       name, recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return false;
  }
  if (n < min || n > max) {
    scr_num_received(n, recv);
    int len = snprintf(msg, sizeof msg,
                       "The value of \"%s\" is out of range. It must be %s. Received %s",
                       name, range, recv);
    scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
    return false;
  }
  return true;
}

void scr_fs_read_chk(const ScrDyn *fd, const ScrDyn *buffer, const ScrDyn *offset,
                     const ScrDyn *length, const ScrDyn *position, const ScrStr *fence) {
  if (buffer->kind != SCR_DYN_BYTES) {
    scr_dyn_arg_type_fail("buffer", "an instance of Buffer, TypedArray, or DataView", buffer);
    return;
  }
  if (fd->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail("fd", "of type number", fd);
    return;
  }
  double buflen = (double)buffer->v.bytes->len;
  if (!scr_fs_dyn_absent(offset)) {
    /* validateInteger's MAX_SAFE range first, the buffer bound second —
     * Node renders each with its own max. */
    if (!scr_fs_int_range_chk(offset, "offset", 0, 9007199254740991.0,
                              ">= 0 && <= 9007199254740991")) {
      return;
    }
    if (offset->v.num > buflen) {
      char range[64];
      snprintf(range, sizeof range, ">= 0 && <= %.0f", buflen);
      if (!scr_fs_int_range_chk(offset, "offset", 0, buflen, range)) return;
    }
  }
  double off = offset->kind == SCR_DYN_NUM ? offset->v.num : 0;
  if (!scr_fs_dyn_absent(length)) {
    if (length->kind != SCR_DYN_NUM || !(isfinite(length->v.num) && trunc(length->v.num) == length->v.num) ||
        length->v.num < 0) {
      /* Node renders the bare ">= 0" form here (checkPosition's cousin). */
      if (length->kind == SCR_DYN_NUM) {
        char recv[48], msg[160];
        scr_num_received(length->v.num, recv);
        const char *shape = (isfinite(length->v.num) && trunc(length->v.num) == length->v.num)
                                ? "It must be >= 0."
                                : "It must be an integer.";
        int len = snprintf(msg, sizeof msg,
                           "The value of \"length\" is out of range. %s Received %s", shape, recv);
        scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
        return;
      }
      scr_dyn_arg_type_fail("length", "of type number", length);
      return;
    }
    if (length->v.num > buflen - off) {
      char recv[48], msg[160];
      scr_num_received(length->v.num, recv);
      int len = snprintf(msg, sizeof msg,
                         "The value of \"length\" is out of range. It must be <= %.0f. Received %s",
                         buflen - off, recv);
      scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)len, "ERR_OUT_OF_RANGE");
      return;
    }
  }
  if (!scr_fs_dyn_absent(position)) {
    if (position->kind != SCR_DYN_NUM) {
      scr_dyn_arg_type_fail("position", "of type bigint or integer", position);
      return;
    }
    if (!scr_fs_int_range_chk(position, "position", -1, 9007199254740991.0,
                              ">= -1 && <= 9007199254740991")) {
      return;
    }
  }
  scr_throw_lowering_fence(fence);
}

/* createReadStream/createWriteStream(path, options?): getOptions'
 * assertEncoding, the fd member's FileHandle-or-integer contract when
 * present, the path contract otherwise; the stream machinery fences. */
void scr_fs_stream_opts_chk(const ScrDyn *path, const ScrDyn *opts, const ScrStr *fence) {
  if (!scr_fs_encoding_chk(opts)) return;
  const ScrDyn *fd = opts->kind == SCR_DYN_OBJ ? scr_dyn_obj_get(opts, "fd", 2) : NULL;
  if (fd != NULL && !scr_fs_dyn_absent(fd)) {
    if (fd->kind != SCR_DYN_NUM) {
      scr_dyn_prop_type_fail("options.fd", "of type number or an instance of FileHandle", fd);
      return;
    }
    if (!scr_fs_int_range_chk(fd, "fd", 0, 2147483647.0, ">= 0 && <= 2147483647")) return;
  } else if (!scr_fs_path_chk(path, "path")) {
    return;
  }
  scr_throw_lowering_fence(fence);
}
