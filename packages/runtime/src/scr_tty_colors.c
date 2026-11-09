/* tty.WriteStream#getColorDepth and #hasColors for the process streams.
 *
 * A program that holds a process stream as a value and names one of the two
 * methods links this unit and the SCR_TTY_COLORS build of scr_events.c,
 * whose stream object asks scr_tty_colors_method for a member it does not
 * know while its descriptor is a terminal. Every other program links
 * neither: its stream object answers undefined for the two names, as it
 * does for every name it does not know.
 */
#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void scr_tty_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

/* The stream object's named refusal (scr_events.c). */
static ScrDyn *scr_tty_refusal(const char *name) {
  char message[192];
  int length = snprintf(message, sizeof message, "Native process stream %s has no lowering [SC2020]", name);
  scr_throw_error_msg_code(SCR_ERR_ERROR, message, (size_t)length, "SC2020");
  return NULL;
}

/* tty.WriteStream#getColorDepth and #hasColors: Node's lib/internal/tty.js,
 * statement by statement. Each `env.NAME` of that source is one read here,
 * so an accessor or a Proxy sees the same reads in the same order. The
 * environment is the argument (a plain object, a Proxy or a primitive), or
 * process.env when the argument is undefined (env NULL). After a throw every
 * further read is skipped and the answer is not used. */
typedef struct {
  const ScrDyn *env;
  bool failed;
} ScrTtyEnv;

/* The FORCE_COLOR warning is reported once per process (Node's `warned`). */
static SCR_TL bool scr_tty_colors_warned;

/* `env.NAME` (+1). */
static ScrDyn *scr_tty_env_read(ScrTtyEnv *e, const char *name) {
  size_t length = strlen(name);
  if (e->failed) return scr_dyn_retain(scr_dyn_undefined());
  if (!e->env) {
    ScrStr *key = scr_str_new(name, length);
    ScrStr *value = scr_env_get(key);
    scr_str_release(key);
    if (!value) return scr_dyn_retain(scr_dyn_undefined());
    ScrDyn *boxed = scr_dyn_new_str(value);
    scr_str_release(value);
    return boxed;
  }
  /* A primitive has none of these members. */
  if (e->env->kind != SCR_DYN_OBJ && e->env->kind != SCR_DYN_PROXY) return scr_dyn_retain(scr_dyn_undefined());
  ScrDyn *value = scr_dyn_obj_read(e->env, name, length);
  if (scr_exc_pending()) {
    scr_dyn_release(value);
    e->failed = true;
    return scr_dyn_retain(scr_dyn_undefined());
  }
  return value ? value : scr_dyn_retain(scr_dyn_undefined());
}

static bool scr_tty_text_is(const ScrDyn *value, const char *text) {
  size_t length = strlen(text);
  return value->kind == SCR_DYN_STR && value->v.str->len == length && memcmp(value->v.str->data, text, length) == 0;
}

/* `env.NAME !== undefined` */
static bool scr_tty_env_defined(ScrTtyEnv *e, const char *name) {
  ScrDyn *value = scr_tty_env_read(e, name);
  bool defined = value->kind != SCR_DYN_UNDEF;
  scr_dyn_release(value);
  return defined;
}

/* `env.NAME === text` */
static bool scr_tty_env_is(ScrTtyEnv *e, const char *name, const char *text) {
  ScrDyn *value = scr_tty_env_read(e, name);
  bool same = scr_tty_text_is(value, text);
  scr_dyn_release(value);
  return same;
}

/* `env.NAME` as a condition. */
static bool scr_tty_env_truthy(ScrTtyEnv *e, const char *name) {
  ScrDyn *value = scr_tty_env_read(e, name);
  bool truthy = scr_dyn_truthy(value);
  scr_dyn_release(value);
  return truthy;
}

/* `env.NAME !== undefined && env.NAME !== ''` */
static bool scr_tty_env_set(ScrTtyEnv *e, const char *name) {
  return scr_tty_env_defined(e, name) && !scr_tty_env_is(e, name, "");
}

/* `hasOwn(env, NAME)` and `NAME in env`. */
static bool scr_tty_env_has(ScrTtyEnv *e, const char *name, bool own) {
  if (e->failed) return false;
  ScrStr *key = scr_str_new(name, strlen(name));
  bool found;
  if (!e->env) {
    ScrStr *value = scr_env_get(key);
    found = value != NULL;
    scr_str_release(value);
  } else {
    found = own ? scr_dyn_has_own(e->env, key) : scr_dyn_in(e->env, key);
    if (scr_exc_pending()) {
      e->failed = true;
      found = false;
    }
  }
  scr_str_release(key);
  return found;
}

/* The string a regular expression or toLowerCase sees for `env.NAME`
 * (+1), or NULL after a throw. The conversion is ToString with the object
 * protocol: a value's own toString or valueOf is called, once for each
 * use, and what it throws leaves the color method. */
static ScrStr *scr_tty_env_text(ScrTtyEnv *e, const char *name) {
  ScrDyn *value = scr_tty_env_read(e, name);
  ScrStr *text = NULL;
  if (e->failed) text = NULL;
  else if (value->kind == SCR_DYN_STR) text = scr_str_retain(value->v.str);
  else if (value->kind == SCR_DYN_UNDEF) text = scr_str_new("undefined", 9);
  else if (value->kind == SCR_DYN_NULL) text = scr_str_new("null", 4);
  else {
    text = scr_dyn_string_coerce_js(value);
    if (!text || scr_exc_pending()) {
      scr_str_release(text);
      text = NULL;
      e->failed = true;
    }
  }
  scr_dyn_release(value);
  return text;
}

static bool scr_tty_starts(const ScrStr *text, const char *prefix) {
  size_t length = strlen(prefix);
  return text->len >= length && memcmp(text->data, prefix, length) == 0;
}

static bool scr_tty_contains(const ScrStr *text, const char *part) {
  size_t length = strlen(part);
  for (size_t i = 0; i + length <= text->len; i++)
    if (memcmp(text->data + i, part, length) == 0) return true;
  return false;
}

static bool scr_tty_digit(const ScrStr *text, size_t i) {
  return i < text->len && text->data[i] >= '0' && text->data[i] <= '9';
}

/* /^(9\.(0*[1-9]\d*)\.|\d{2,}\.)/ */
static bool scr_tty_teamcity(const ScrStr *text) {
  size_t i = 0;
  if (scr_tty_starts(text, "9.")) {
    i = 2;
    while (i < text->len && text->data[i] == '0') i++;
    if (scr_tty_digit(text, i) && text->data[i] != '0') {
      while (scr_tty_digit(text, i)) i++;
      if (i < text->len && text->data[i] == '.') return true;
    }
  }
  i = 0;
  while (scr_tty_digit(text, i)) i++;
  return i >= 2 && i < text->len && text->data[i] == '.';
}

/* String.prototype.toLowerCase as far as the terminal names can tell (they
 * are ASCII): ASCII letters, and the two characters whose lower case holds
 * an ASCII letter, U+212A KELVIN SIGN (k) and U+0130 (i, U+0307). Every
 * other character is kept. +1. */
static ScrStr *scr_tty_lower(const ScrStr *text) {
  char *buffer = malloc(text->len * 3 / 2 + 2);
  if (!buffer) scr_tty_oom();
  size_t n = 0;
  for (size_t i = 0; i < text->len; i++) {
    unsigned char c = (unsigned char)text->data[i];
    if (c >= 'A' && c <= 'Z') buffer[n++] = (char)(c + 32);
    else if (c == 0xE2 && i + 2 < text->len && (unsigned char)text->data[i + 1] == 0x84 &&
             (unsigned char)text->data[i + 2] == 0xAA) {
      buffer[n++] = 'k';
      i += 2;
    } else if (c == 0xC4 && i + 1 < text->len && (unsigned char)text->data[i + 1] == 0xB0) {
      buffer[n++] = 'i';
      buffer[n++] = (char)0xCC;
      buffer[n++] = (char)0x87;
      i += 1;
    } else buffer[n++] = (char)c;
  }
  ScrStr *lower = scr_str_new(buffer, n);
  free(buffer);
  return lower;
}

/* TERM_ENVS[termEnv] and TERM_ENVS_REG_EXP over the lower-cased TERM: the
 * depth, 0 for no entry, -1 for a name TERM_ENVS inherits from
 * Object.prototype (Node answers that member, which is no depth). */
static int scr_tty_term_depth(const ScrStr *term) {
  static const struct { const char *name; int depth; } names[] = {
    {"eterm", 4}, {"cons25", 4}, {"console", 4}, {"cygwin", 4}, {"dtterm", 4}, {"gnome", 4},
    {"hurd", 4}, {"jfbterm", 4}, {"konsole", 4}, {"kterm", 4}, {"mlterm", 4}, {"mosh", 24},
    {"putty", 4}, {"st", 4}, {"rxvt-unicode-24bit", 24}, {"terminator", 24}, {"xterm-kitty", 24},
    {"constructor", -1}, {"__proto__", -1},
  };
  for (size_t i = 0; i < sizeof names / sizeof *names; i++)
    if (term->len == strlen(names[i].name) && memcmp(term->data, names[i].name, term->len) == 0) return names[i].depth;
  if (scr_tty_contains(term, "ansi") || scr_tty_contains(term, "color") || scr_tty_contains(term, "linux") ||
      scr_tty_contains(term, "direct") || scr_tty_starts(term, "rxvt") || scr_tty_starts(term, "screen") ||
      scr_tty_starts(term, "xterm") || scr_tty_starts(term, "vt100") || scr_tty_starts(term, "vt220"))
    return 4;
  /* /^con[0-9]*x[0-9]/ */
  if (scr_tty_starts(term, "con")) {
    size_t i = 3;
    while (scr_tty_digit(term, i)) i++;
    if (i < term->len && term->data[i] == 'x' && scr_tty_digit(term, i + 1)) return 4;
  }
  return 0;
}

/* process.emitWarning's next-tick delivery of the FORCE_COLOR warning: to
 * the 'warning' listeners (or the program's emitWarning replacement) when
 * the process-warning unit is linked, otherwise Node's default report. */
static void scr_tty_warn_tick(ScrClosure *self) {
  ScrDyn *boxed = scr_box_get_ref(self->caps[0]);
  ScrStr *message = boxed->v.str;
  if (scr_warning_emit_hook) {
    scr_warning_emit_hook("Warning", NULL, message);
  } else {
    long pid = (long)scr_process_pid();
    scr_stdout_settle();
    fflush(stdout);
    fprintf(stderr, "(node:%ld) Warning: %.*s\n", pid, (int)message->len, message->data);
    if (!scr_warning_trace_hint_shown) {
      scr_warning_trace_hint_shown = true;
      fputs("(Use `node --trace-warnings ...` to show where the warning was created)\n", stderr);
    }
  }
  scr_dyn_release(boxed);
}

/* warnOnDeactivatedColors. */
static void scr_tty_warn_deactivated(ScrTtyEnv *e) {
  if (scr_tty_colors_warned) return;
  bool node = scr_tty_env_set(e, "NODE_DISABLE_COLORS");
  bool none = scr_tty_env_set(e, "NO_COLOR");
  if (e->failed || (!node && !none)) return;
  char text[128];
  int length = snprintf(text, sizeof text, "The '%s' env is ignored due to the 'FORCE_COLOR' env being set.",
                        node && none ? "NODE_DISABLE_COLORS' and 'NO_COLOR" : node ? "NODE_DISABLE_COLORS" : "NO_COLOR");
  ScrStr *message = scr_str_new(text, (size_t)length);
  ScrClosure *tick = scr_closure_new((void *)scr_tty_warn_tick, 1);
  tick->caps[0] = scr_box_new_obj(scr_dyn_retain_v, scr_dyn_release_v, scr_dyn_trace_v);
  ScrDyn *boxed = scr_dyn_new_str(message);
  scr_box_set_ref(tick->caps[0], boxed);
  scr_str_release(message);
  scr_next_tick(tick);
  scr_tty_colors_warned = true;
}

static double scr_tty_color_depth(ScrTtyEnv *e) {
  if (scr_tty_env_defined(e, "FORCE_COLOR")) {
    ScrDyn *force = scr_tty_env_read(e, "FORCE_COLOR");
    double depth = scr_tty_text_is(force, "") || scr_tty_text_is(force, "1") || scr_tty_text_is(force, "true") ? 4
                   : scr_tty_text_is(force, "2") ? 8 : scr_tty_text_is(force, "3") ? 24 : 1;
    scr_dyn_release(force);
    if (depth != 1) scr_tty_warn_deactivated(e);
    return depth;
  }
  if (scr_tty_env_set(e, "NODE_DISABLE_COLORS") || scr_tty_env_set(e, "NO_COLOR") || scr_tty_env_is(e, "TERM", "dumb"))
    return 1;
#ifdef _WIN32
  {
    /* Windows 10 build 10586 has 256 colors, build 14931 true color. */
    ScrStr *release = scr_os_release();
    int major = 0, minor = 0, build = 0;
    sscanf(release->data, "%d.%d.%d", &major, &minor, &build);
    scr_str_release(release);
    if (major >= 10 && build >= 14931) return 24;
    if (major >= 10 && build >= 10586) return 8;
    return 4;
  }
#endif
  if (scr_tty_env_truthy(e, "TMUX")) return 24;
  if (scr_tty_env_has(e, "TF_BUILD", true) && scr_tty_env_has(e, "AGENT_NAME", true)) return 4;
  if (scr_tty_env_has(e, "CI", true)) {
    static const struct { const char *name; int depth; } services[] = {
      {"APPVEYOR", 8}, {"BUILDKITE", 8}, {"CIRCLECI", 24}, {"DRONE", 8},
      {"GITEA_ACTIONS", 24}, {"GITHUB_ACTIONS", 24}, {"GITLAB_CI", 8}, {"TRAVIS", 8},
    };
    for (size_t i = 0; i < sizeof services / sizeof *services; i++)
      if (scr_tty_env_has(e, services[i].name, true)) return services[i].depth;
    return scr_tty_env_is(e, "CI_NAME", "codeship") ? 8 : 1;
  }
  if (scr_tty_env_has(e, "TEAMCITY_VERSION", false)) {
    ScrStr *version = scr_tty_env_text(e, "TEAMCITY_VERSION");
    bool recent = version && scr_tty_teamcity(version);
    scr_str_release(version);
    return recent ? 4 : 1;
  }
  ScrDyn *program = scr_tty_env_read(e, "TERM_PROGRAM");
  int kind = scr_tty_text_is(program, "iTerm.app") ? 1
             : scr_tty_text_is(program, "HyperTerm") || scr_tty_text_is(program, "MacTerm") ? 2
             : scr_tty_text_is(program, "Apple_Terminal") ? 3 : 0;
  scr_dyn_release(program);
  if (kind == 1) {
    if (!scr_tty_env_truthy(e, "TERM_PROGRAM_VERSION")) return 8;
    /* /^[0-2]\./ */
    ScrStr *version = scr_tty_env_text(e, "TERM_PROGRAM_VERSION");
    bool old = version && version->len >= 2 && version->data[0] >= '0' && version->data[0] <= '2' && version->data[1] == '.';
    scr_str_release(version);
    return old ? 8 : 24;
  }
  if (kind == 2) return 24;
  if (kind == 3) return 8;
  if (scr_tty_env_is(e, "COLORTERM", "truecolor") || scr_tty_env_is(e, "COLORTERM", "24bit")) return 24;
  if (scr_tty_env_truthy(e, "TERM")) {
    ScrStr *term = scr_tty_env_text(e, "TERM");
    bool truecolor = term && scr_tty_contains(term, "truecolor");
    scr_str_release(term);
    if (truecolor) return 24;
    term = scr_tty_env_text(e, "TERM");
    bool xterm256 = term && scr_tty_starts(term, "xterm-256");
    scr_str_release(term);
    if (xterm256) return 8;
    term = scr_tty_env_text(e, "TERM");
    ScrStr *lower = term ? scr_tty_lower(term) : NULL;
    int depth = lower ? scr_tty_term_depth(lower) : 0;
    scr_str_release(lower);
    scr_str_release(term);
    if (depth < 0) {
      scr_tty_refusal("getColorDepth for a TERM that names a member of Object.prototype");
      e->failed = true;
    }
    if (depth != 0) return depth;
  }
  return scr_tty_env_truthy(e, "COLORTERM") ? 4 : 1;
}

/* getColorDepth(env = process.env) and hasColors(count, env). Neither reads
 * its receiver, as in Node. */
static ScrDyn *scr_tty_colors(bool has, ScrDyn *const *args, size_t argc) {
  const ScrDyn *env = argc ? args[0] : scr_dyn_undefined();
  double count = 16;
  if (has) {
    const ScrDyn *first = env;
    env = argc > 1 ? args[1] : scr_dyn_undefined();
    ScrStr *type = scr_dyn_typeof(first);
    bool object = first->kind != SCR_DYN_NULL && type->len == 6 && memcmp(type->data, "object", 6) == 0;
    scr_str_release(type);
    if (env->kind == SCR_DYN_UNDEF && (first->kind == SCR_DYN_UNDEF || object)) {
      env = first;
    } else {
      /* validateInteger(count, 'count', 2) */
      if (first->kind != SCR_DYN_NUM) {
        scr_dyn_arg_type_fail("count", "of type number", first);
        return NULL;
      }
      count = first->v.num;
      bool integer = isfinite(count) && trunc(count) == count;
      if (!integer || count < 2 || count > 9007199254740991.0) {
        char received[48], text[160];
        scr_num_received(count, received);
        int length = snprintf(text, sizeof text, "The value of \"count\" is out of range. It must be %s. Received %s",
                              integer ? ">= 2 && <= 9007199254740991" : "an integer", received);
        scr_throw_error_msg_code(SCR_ERR_RANGE, text, (size_t)length, "ERR_OUT_OF_RANGE");
        return NULL;
      }
    }
  }
  ScrTtyEnv e = {NULL, false};
  ScrDyn *held = NULL;
  if (env->kind == SCR_DYN_NULL) {
    static const char message[] = "Cannot read properties of null (reading 'FORCE_COLOR')";
    scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    return NULL;
  }
  if (env->kind != SCR_DYN_UNDEF) {
    /* A statically typed record arrives as a view: read its plain form. */
    held = env->kind == SCR_DYN_TYPED_REF ? scr_dyn_typed_ref_materialize(env) : scr_dyn_retain((ScrDyn *)env);
    if (!held) return NULL;
    if (held->kind != SCR_DYN_OBJ && held->kind != SCR_DYN_PROXY && held->kind != SCR_DYN_STR &&
        held->kind != SCR_DYN_NUM && held->kind != SCR_DYN_BOOL) {
      scr_dyn_release(held);
      return scr_tty_refusal(has ? "hasColors with an environment that is not a plain object"
                                 : "getColorDepth with an environment that is not a plain object");
    }
    e.env = held;
  }
  double depth = scr_tty_color_depth(&e);
  scr_dyn_release(held);
  if (e.failed || scr_exc_pending()) return NULL;
  return has ? scr_dyn_new_bool(count <= pow(2, depth)) : scr_dyn_new_num(depth);
}

static ScrDyn *scr_tty_get_color_depth(ScrClosure *cb, ScrDyn *const *args, size_t argc) {
  (void)cb;
  return scr_tty_colors(false, args, argc);
}

static ScrDyn *scr_tty_has_colors(ScrClosure *cb, ScrDyn *const *args, size_t argc) {
  (void)cb;
  return scr_tty_colors(true, args, argc);
}

/* The two function values, made on first read: one of each per thread, so
 * stdout's and stderr's are the same function, as the prototype's are. */
static SCR_TL ScrDyn *scr_tty_colors_methods[2];

ScrDyn *scr_tty_colors_method(const char *key, size_t length) {
  bool has = length == 9 && memcmp(key, "hasColors", 9) == 0;
  if (!has && !(length == 13 && memcmp(key, "getColorDepth", 13) == 0)) return NULL;
  if (!scr_tty_colors_methods[has])
    scr_tty_colors_methods[has] =
        has ? scr_dyn_new_func(scr_closure_new(NULL, 0), scr_tty_has_colors, 2, "", "hasColors")
            : scr_dyn_new_func(scr_closure_new(NULL, 0), scr_tty_get_color_depth, 0, "", "getColorDepth");
  return scr_dyn_retain(scr_tty_colors_methods[has]);
}

void scr_tty_colors_cleanup(void) {
  scr_tty_colors_warned = false;
  for (int i = 0; i < 2; i++) {
    scr_dyn_release(scr_tty_colors_methods[i]);
    scr_tty_colors_methods[i] = NULL;
  }
}
