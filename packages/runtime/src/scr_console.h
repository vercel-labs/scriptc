/* scriptc runtime — console (scr_console.c). Included by scr_runtime.h, which
 * says where new declarations go. */
#ifndef SCR_CONSOLE_H
#define SCR_CONSOLE_H

#include "scr_http2.h"

/* ── console ──────────────────────────────────────────────────────────── */

enum {
  SCR_ARG_F64,  /* a number argument: inspect rendering (-0 prints "-0") */
  SCR_ARG_STR,  /* a string, verbatim */
  SCR_ARG_BOOL, /* true / false */
  SCR_ARG_NUM,  /* a number inside a string concatenation: String() rendering
                 * (-0 prints "0") — scr_console_*_parts only */
  SCR_ARG_KIND = 0xff,
  SCR_ARG_GLUE = 0x100, /* flag: this part continues the previous argument
                         * (no separating space) — scr_console_*_parts only */
};

typedef struct {
  int tag; /* SCR_ARG_KIND bits, optionally | SCR_ARG_GLUE */
  union {
    double f;
    ScrStr *s;
    bool b;
  } v;
} ScrLogArg;

/* Space-joined args + '\n', submitted before return. Borrows string args. */
void scr_console_log(size_t n, const ScrLogArg *args);
/* The stderr twin (console.error AND console.warn — one stream in Node):
 * identical formatting, with stdout settled first so merged (2>&1) output
 * keeps source order. */
void scr_console_error(size_t n, const ScrLogArg *args);
/* The same lines where the compiler passed a string-concatenation argument
 * (template literal, `"a" + n`) as its parts — glued with SCR_ARG_GLUE and
 * numbers as SCR_ARG_NUM — so the joined string is never materialized.
 * Separate entry points: programs using these tags cannot link against a
 * runtime that does not understand them. */
void scr_console_log_parts(size_t n, const ScrLogArg *args);
void scr_console_error_parts(size_t n, const ScrLogArg *args);
/* A Console instance's line on fd 1 or 2, without the global console's
 * group indentation, under the instance's ignoreErrors. */
void scr_console_write_fd(int fd, size_t n, const ScrLogArg *args, bool ignore_errors);
/* The global console's line rewrite while a group is open (scr_console.c;
 * installed by scr_console_group): the indented heap copy of a rendered
 * line, its length in *used. */
extern SCR_TL char *(*scr_console_indenter)(const char *line, size_t *used);

/* The global console's remaining members (scr_console_native.c). Arguments
 * are borrowed; string results are +1. */
ScrStr *scr_console_label(ScrDyn *label);
void scr_console_count(ScrStr *label);
ScrStr *scr_console_count_reset(ScrDyn *label);
ScrStr *scr_console_time(ScrStr *label);
ScrStr *scr_console_time_end(ScrStr *label);
ScrStr *scr_console_time_log(ScrStr *label);
void scr_console_group(double delta);
void scr_console_clear(void);
void scr_console_table(ScrDyn *data, ScrDyn *properties);
ScrStr *scr_console_dir_dyn(ScrDyn *value, double depth);
ScrStr *scr_console_dir_hidden(ScrDyn *value, double depth);
/* console.table's cell rendering (scr_inspect.c): Node's _inspect — depth
 * 0 (-1 for objects with more than two keys), maxArrayLength 3, breakLength
 * Infinity. +1. */
ScrStr *scr_insp_table_cell(ScrDyn *value);
/* Node's getStringWidth over UTF-8 text (the non-ICU tables). */
size_t scr_insp_display_width(const char *data, size_t len);
/* process.emitWarning(message) with the default Warning type, emitted on
 * the next tick like Node's; an empty message emits nothing
 * (scr_async_dyn.c). Borrows. */
void scr_process_emit_warning_text(ScrStr *message);

bool scr_fetch_web_is(const ScrDyn *value, const ScrStr *name);
bool scr_fetch_stream_is(const ScrDyn *value);

#endif /* SCR_CONSOLE_H */
