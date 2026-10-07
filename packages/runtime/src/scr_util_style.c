#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Standard Node 24 inspect colors, including its non-enumerable aliases.
 * Native inspect.colors mutation has no static surface. */
typedef struct ScrTextStyle { const char *name; unsigned open, close; } ScrTextStyle;
static const ScrTextStyle util_text_styles[] = {
  { "reset", 0, 0 },
  { "bold", 1, 22 },
  { "dim", 2, 22 },
  { "italic", 3, 23 },
  { "underline", 4, 24 },
  { "blink", 5, 25 },
  { "inverse", 7, 27 },
  { "hidden", 8, 28 },
  { "strikethrough", 9, 29 },
  { "doubleunderline", 21, 24 },
  { "black", 30, 39 },
  { "red", 31, 39 },
  { "green", 32, 39 },
  { "yellow", 33, 39 },
  { "blue", 34, 39 },
  { "magenta", 35, 39 },
  { "cyan", 36, 39 },
  { "white", 37, 39 },
  { "bgBlack", 40, 49 },
  { "bgRed", 41, 49 },
  { "bgGreen", 42, 49 },
  { "bgYellow", 43, 49 },
  { "bgBlue", 44, 49 },
  { "bgMagenta", 45, 49 },
  { "bgCyan", 46, 49 },
  { "bgWhite", 47, 49 },
  { "framed", 51, 54 },
  { "overlined", 53, 55 },
  { "gray", 90, 39 },
  { "redBright", 91, 39 },
  { "greenBright", 92, 39 },
  { "yellowBright", 93, 39 },
  { "blueBright", 94, 39 },
  { "magentaBright", 95, 39 },
  { "cyanBright", 96, 39 },
  { "whiteBright", 97, 39 },
  { "bgGray", 100, 49 },
  { "bgRedBright", 101, 49 },
  { "bgGreenBright", 102, 49 },
  { "bgYellowBright", 103, 49 },
  { "bgBlueBright", 104, 49 },
  { "bgMagentaBright", 105, 49 },
  { "bgCyanBright", 106, 49 },
  { "bgWhiteBright", 107, 49 },
  { "grey", 90, 39 },
  { "blackBright", 90, 39 },
  { "bgGrey", 100, 49 },
  { "bgBlackBright", 100, 49 },
  { "faint", 2, 22 },
  { "crossedout", 9, 29 },
  { "strikeThrough", 9, 29 },
  { "crossedOut", 9, 29 },
  { "conceal", 8, 28 },
  { "swapColors", 7, 27 },
  { "swapcolors", 7, 27 },
  { "doubleUnderline", 21, 24 },
};

static ScrDyn *util_style_view(const ScrDyn *value) {
  return value->kind == SCR_DYN_TYPED_REF ? scr_dyn_typed_ref_materialize(value)
                                         : scr_dyn_retain((ScrDyn *)value);
}

static ScrDyn *util_style_member(const ScrDyn *value, const char *key) {
  if (value->kind == SCR_DYN_UNDEF || value->kind == SCR_DYN_NULL)
    return scr_dyn_retain(scr_dyn_undefined());
  ScrDyn *view = util_style_view(value);
  if (!view) return NULL;
  ScrDyn *result = scr_dyn_obj_read(view, key, strlen(key));
  scr_dyn_release(view);
  return result;
}

static const ScrTextStyle *util_style_lookup(const ScrDyn *key) {
  if (key->kind == SCR_DYN_SYMBOL) return NULL;
  ScrStr *name = scr_dyn_string_constructor(key);
  if (!name) return NULL;
  const ScrTextStyle *result = NULL;
  for (size_t i = 0; i < sizeof util_text_styles / sizeof util_text_styles[0]; i++) {
    if (name->len == strlen(util_text_styles[i].name) &&
        !memcmp(name->data, util_text_styles[i].name, name->len)) {
      result = &util_text_styles[i]; break;
    }
  }
  scr_str_release(name);
  return result;
}

static bool util_style_none(const ScrDyn *key) {
  return key->kind == SCR_DYN_STR && key->v.str->len == 4 &&
         !memcmp(key->v.str->data, "none", 4);
}

static void util_style_invalid(const ScrDyn *key) {
  ScrDyn *view = util_style_view(key);
  if (!view) return;
  ScrStr *shown = scr_insp_dyn(view, 0, 2);
  scr_dyn_release(view);
  if (!shown) return;
  ScrJsonBuf message;
  scr_jb_init(&message);
  scr_jb_puts(&message, "The argument 'format' must be one of: ");
  for (size_t i = 0; i < sizeof util_text_styles / sizeof util_text_styles[0]; i++) {
    if (i) scr_jb_puts(&message, ", ");
    scr_jb_putc(&message, '\'');
    scr_jb_puts(&message, util_text_styles[i].name);
    scr_jb_putc(&message, '\'');
  }
  scr_jb_puts(&message, ". Received ");
  scr_jb_put_str(&message, shown);
  ScrStr *text = scr_jb_finish(&message);
  scr_throw_error_msg_code(SCR_ERR_TYPE, text->data, text->len, "ERR_INVALID_ARG_VALUE");
  scr_str_release(text); scr_str_release(shown);
}

/* Reopen an outer style when a nested fragment closes it. Bold and dim
 * share 22, so preserve that reset before restoring either attribute.
 * A close at the very end is kept intact, matching Node's replacement. */
static void util_style_putn(ScrJsonBuf *buffer, const char *data, size_t length) {
  for (size_t i = 0; i < length; i++) scr_jb_putc(buffer, data[i]);
}

static ScrStr *util_style_replace(const ScrStr *text, const char *close,
                                  const char *open, bool keep_close) {
  size_t close_len = strlen(close), at = 0;
  ScrJsonBuf result;
  scr_jb_init(&result);
  for (size_t i = 0; i + close_len < text->len;) {
    if (!memcmp(text->data + i, close, close_len)) {
      util_style_putn(&result, text->data + at, i - at);
      if (keep_close) scr_jb_puts(&result, close);
      scr_jb_puts(&result, open);
      i += close_len; at = i;
    } else i++;
  }
  util_style_putn(&result, text->data + at, text->len - at);
  return scr_jb_finish(&result);
}

static bool util_style_env_nonempty(const char *name) {
  const char *value = scr_getenv(name);
  return value && *value;
}

/* Node recognizes structural stream implementations as well as branded
 * instances. Keep that valid shape outside the native stdio boundary. */
static bool util_style_custom_stream(const ScrDyn *stream) {
  static const char *const keys[] = { "_readableState", "_writableState", "write", "on", "pipe", "pipeThrough", "getReader", "cancel", "getWriter", "abort" };
  ScrDyn *members[sizeof keys / sizeof keys[0]] = {0};
  bool result = false;
  for (size_t i = 0; i < sizeof keys / sizeof keys[0]; i++) {
    members[i] = util_style_member(stream, keys[i]);
    if (!members[i] || scr_exc_pending()) goto done;
  }
  result = scr_dyn_truthy(members[0]) || scr_dyn_truthy(members[1]) ||
    (members[3]->kind == SCR_DYN_FUNC && (members[2]->kind == SCR_DYN_FUNC || members[4]->kind == SCR_DYN_FUNC)) ||
    (members[5]->kind == SCR_DYN_FUNC && members[6]->kind == SCR_DYN_FUNC && members[7]->kind == SCR_DYN_FUNC) ||
    (members[8]->kind == SCR_DYN_FUNC && members[9]->kind == SCR_DYN_FUNC);
done:
  for (size_t i = 0; i < sizeof keys / sizeof keys[0]; i++) scr_dyn_release(members[i]);
  return result;
}

/* styleText only needs the color/no-color distinction, rather than the
 * full 4/8/24-bit depth. Follow the ordering of Node 24 internal/tty. */
static bool util_style_terminal_colors(void) {
  const char *force = scr_getenv("FORCE_COLOR");
  if (force) {
    bool enabled = !strcmp(force, "") || !strcmp(force, "true") ||
      !strcmp(force, "1") || !strcmp(force, "2") || !strcmp(force, "3");
    static SCR_TL bool warned = false;
    const char *disabled = util_style_env_nonempty("NO_COLOR") ? "NO_COLOR" :
      util_style_env_nonempty("NODE_DISABLE_COLORS") ? "NODE_DISABLE_COLORS" : NULL;
    if (enabled && disabled && !warned) {
      ScrJsonBuf message;
      scr_jb_init(&message);
      scr_jb_puts(&message, "The '"); scr_jb_puts(&message, disabled);
      scr_jb_puts(&message, "' env is ignored due to the 'FORCE_COLOR' env being set.");
      ScrStr *text = scr_jb_finish(&message);
      scr_emit_warning("Warning", NULL, text);
      scr_str_release(text); warned = true;
    }
    return enabled;
  }
  const char *term = scr_getenv("TERM");
  if (util_style_env_nonempty("NO_COLOR") || util_style_env_nonempty("NODE_DISABLE_COLORS") ||
      (term && !strcmp(term, "dumb"))) return false;
#ifdef _WIN32
  return true;
#endif
  if (util_style_env_nonempty("TMUX")) return true;
  if (scr_getenv("TF_BUILD") && scr_getenv("AGENT_NAME")) return true;
  if (scr_getenv("CI")) {
    static const char *const ci[] = { "APPVEYOR", "BUILDKITE", "CIRCLECI", "DRONE", "GITEA_ACTIONS", "GITHUB_ACTIONS", "GITLAB_CI", "TRAVIS" };
    for (size_t i = 0; i < sizeof ci / sizeof ci[0]; i++) if (scr_getenv(ci[i])) return true;
    const char *name = scr_getenv("CI_NAME");
    return name && !strcmp(name, "codeship");
  }
  const char *teamcity = scr_getenv("TEAMCITY_VERSION");
  if (teamcity) {
    const char *p = teamcity;
    if (!strncmp(p, "9.", 2)) {
      p += 2; while (*p == '0') p++;
      if (*p < '1' || *p > '9') return false;
      while (*p >= '0' && *p <= '9') p++;
      return *p == '.';
    }
    while (*p >= '0' && *p <= '9') p++;
    return p - teamcity >= 2 && *p == '.';
  }
  const char *program = scr_getenv("TERM_PROGRAM");
  if (program && (!strcmp(program, "iTerm.app") || !strcmp(program, "HyperTerm") ||
                  !strcmp(program, "MacTerm") || !strcmp(program, "Apple_Terminal"))) return true;
  const char *colorterm = scr_getenv("COLORTERM");
  if (colorterm && (!strcmp(colorterm, "truecolor") || !strcmp(colorterm, "24bit"))) return true;
  if (term) {
    if (strstr(term, "truecolor") || !strncmp(term, "xterm-256", 9)) return true;
    char *lower = malloc(strlen(term) + 1);
    if (!lower) abort();
    for (size_t i = 0; i <= strlen(term); i++) lower[i] = term[i] >= 'A' && term[i] <= 'Z' ? term[i] + ('a' - 'A') : term[i];
    static const char *const terminals[] = { "eterm", "cons25", "console", "cygwin", "dtterm", "gnome", "hurd", "jfbterm", "konsole", "kterm", "mlterm", "mosh", "putty", "st", "rxvt-unicode-24bit", "terminator", "xterm-kitty" };
    bool found = false;
    for (size_t i = 0; i < sizeof terminals / sizeof terminals[0]; i++) found |= !strcmp(lower, terminals[i]);
    found |= strstr(lower, "ansi") || strstr(lower, "color") || strstr(lower, "linux") || strstr(lower, "direct") ||
      !strncmp(lower, "rxvt", 4) || !strncmp(lower, "screen", 6) || !strncmp(lower, "xterm", 5) ||
      !strncmp(lower, "vt100", 5) || !strncmp(lower, "vt220", 5);
    if (!strncmp(lower, "con", 3)) {
      const char *p = lower + 3;
      while (*p >= '0' && *p <= '9') p++;
      if (*p == 'x' && p[1] >= '0' && p[1] <= '9') found = true;
    }
    free(lower);
    if (found) return true;
  }
  return colorterm && *colorterm;
}

ScrStr *scr_util_style_text(const ScrDyn *format, const ScrDyn *text, const ScrDyn *options) {
  ScrDyn *validate = util_style_member(options, "validateStream");
  if (!validate) return NULL;
  if (validate->kind == SCR_DYN_UNDEF || validate->kind == SCR_DYN_NULL) {
    scr_dyn_release(validate); validate = scr_dyn_new_bool(true);
  }
  const ScrTextStyle *fast = NULL;
  if (!scr_dyn_truthy(validate) && format->kind == SCR_DYN_STR && text->kind == SCR_DYN_STR) {
    if (util_style_none(format)) { scr_dyn_release(validate); return scr_str_retain(text->v.str); }
    fast = util_style_lookup(format);
  }
  bool colorize = true;
  ScrDyn *view = NULL, *stream = NULL;
  ScrStr *result = NULL, *processed = NULL;
  if (!fast) {
    if (text->kind != SCR_DYN_STR) { scr_dyn_arg_type_fail("text", "of type string", text); goto done; }
    view = util_style_view(options);
    if (!view) goto done;
    if (view->kind != SCR_DYN_UNDEF && view->kind != SCR_DYN_OBJ) {
      scr_dyn_arg_type_fail("options", "of type object", view); goto done;
    }
    if (validate->kind != SCR_DYN_BOOL) {
      scr_dyn_prop_type_fail("options.validateStream", "of type boolean", validate); goto done;
    }
    if (validate->v.b) {
      stream = util_style_member(options, "stream");
      if (!stream) goto done;
      if (stream->kind == SCR_DYN_TYPED_REF && !strncmp(stream->v.typed_ref.type_key, "record:", 7)) {
        ScrDyn *native = util_style_view(stream);
        scr_dyn_release(stream); stream = native;
        if (!stream) goto done;
      }
      double fd = 1;
      if (stream->kind != SCR_DYN_UNDEF && stream->kind != SCR_DYN_NULL) {
        if (stream->kind == SCR_DYN_HANDLE && stream->v.handle.tag == SCR_DYNH_STDIO) {
          ScrStr *key = scr_str_new("fd", 2);
          ScrDyn *value = scr_dyn_handle_key_get(stream, key);
          scr_str_release(key);
          if (!value) goto done;
          fd = value->v.num; scr_dyn_release(value);
        } else if (stream->kind == SCR_DYN_HANDLE || stream->kind == SCR_DYN_TYPED_REF ||
                   (stream->kind == SCR_DYN_OBJ && util_style_custom_stream(stream))) {
          static const char message[] = "util.styleText over native custom streams is not supported yet";
          scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "SC2020"); goto done;
        } else {
          if (scr_exc_pending()) goto done;
          scr_dyn_arg_type_fail("stream", "an instance of ReadableStream, WritableStream, or Stream", stream); goto done;
        }
      }
      colorize = scr_getenv("FORCE_COLOR") ? util_style_terminal_colors() :
        scr_process_is_tty(fd) && util_style_terminal_colors();
    }
  }
  scr_dyn_release(view); view = util_style_view(format);
  if (!view) goto done;
  processed = scr_str_retain(text->v.str);
  ScrJsonBuf opens, closes;
  scr_jb_init(&opens); scr_jb_init(&closes);
  size_t count = view->kind == SCR_DYN_ARR ? view->v.arr.len : 1;
  for (size_t i = 0; i < count; i++) {
    const ScrDyn *key = view->kind == SCR_DYN_ARR ? view->v.arr.items[i] : view;
    if (util_style_none(key)) continue;
    const ScrTextStyle *style = util_style_lookup(key);
    if (!style) {
      if (!scr_exc_pending()) util_style_invalid(key);
      scr_str_release(scr_jb_finish(&opens)); scr_str_release(scr_jb_finish(&closes)); goto done;
    }
    char open[16], close[16];
    snprintf(open, sizeof open, "\x1b[%um", style->open);
    snprintf(close, sizeof close, "\x1b[%um", style->close);
    scr_jb_puts(&opens, open);
    size_t n = strlen(close);
    scr_jb_puts(&closes, close);
    /* Prepend each closing sequence so the outer formats close last. */
    memmove(closes.data + n, closes.data, closes.len - n);
    memcpy(closes.data, close, n);
    ScrStr *next = util_style_replace(processed, close, open, style->open == 1 || style->open == 2);
    scr_str_release(processed); processed = next;
  }
  if (colorize) {
    scr_jb_put_str(&opens, processed);
    util_style_putn(&opens, closes.data, closes.len);
    result = scr_jb_finish(&opens);
  } else { scr_str_release(scr_jb_finish(&opens)); result = scr_str_retain(text->v.str); }
  scr_str_release(scr_jb_finish(&closes));
done:
  scr_dyn_release(validate); scr_dyn_release(view); scr_dyn_release(stream);
  scr_str_release(processed);
  return result;
}
