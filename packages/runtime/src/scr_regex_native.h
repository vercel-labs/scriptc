/* Native matcher for one-byte (ASCII) subjects — included only by
 * scr_regex.c (and the standalone differential fuzz harness in
 * packages/runtime/test/regex-native-fuzz.c).
 *
 * libregexp compiles every non-sticky pattern with a `.*?` search prefix and
 * then interprets its bytecode one opcode at a time; an unanchored search
 * pays a backtrack push/pop plus ~7 dispatches for every subject position,
 * and every iteration of `x+` pushes a backtrack state. This file translates
 * the libregexp bytecode body (the bytecode stays the source of truth for
 * parsing, flags, case folding and capture numbering) into a small program
 * for ASCII subjects:
 *
 * - every single-character opcode becomes a 128-entry membership table,
 *   computed by evaluating the opcode's own predicate (lre_canonicalize,
 *   lre_is_space, the range pairs) for each ASCII code unit, so /i and /u
 *   behave exactly as the interpreter does on these subjects;
 * - quantifiers over a single character (`x*`, `x+`, `x?`, `x{n,m}` and lazy
 *   forms) become counted loops that backtrack by count; greedy loops whose
 *   continuation can never start with a character of the loop's own class
 *   are possessive (giving characters back cannot succeed);
 * - runs of single-byte literals become one memcmp;
 * - splits, gotos, saves and capture resets keep libregexp's exact
 *   backtracking order and capture undo semantics;
 * - an unanchored search starts the program only at positions whose byte can
 *   begin a match (memchr when exactly one byte can), and only at position 0
 *   for patterns anchored by a non-multiline `^`.
 *
 * Patterns using anything else (lookaround, back references) are not
 * translated: they keep the
 * libregexp path, as do all subjects with non-ASCII text.
 */
#ifndef SCR_REGEX_NATIVE_H
#define SCR_REGEX_NATIVE_H

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "libregexp.h"
#include "libunicode.h"

/* libregexp's opcode numbering and bytecode header (pinned vendored
 * version; any opcode outside the translated subset is rejected). */
enum {
#define DEF(id, size) SCR_REOP_##id,
#include "libregexp-opcode.h"
#undef DEF
  SCR_REOP_COUNT
};
static const uint8_t scr_reop_size[SCR_REOP_COUNT] = {
#define DEF(id, size) size,
#include "libregexp-opcode.h"
#undef DEF
};
#define SCR_RE_HEADER_LEN 8

/* Translation runs once per pattern: optimize it for size. */
#if defined(__clang__)
#define RN_ONCE __attribute__((minsize))
#else
#define RN_ONCE
#endif

enum {
  RN_CLASS,      /* one byte in tab */
  RN_STR,        /* n literal bytes at str */
  RN_LOOP,       /* tab repeated [min, max] times */
  RN_SAVE,       /* capture slot a = position */
  RN_RESET,      /* capture slots a..b = unset */
  RN_SPLIT_NEXT, /* continue; alternative at target */
  RN_SPLIT_GOTO, /* jump to target; alternative is the next op */
  RN_GOTO,
  RN_BOL,
  RN_BOL_M,
  RN_EOL,
  RN_EOL_M,
  RN_WORDB,
  RN_NWORDB,
  RN_MATCH,
  RN_SETPOS,   /* register slot a = position */
  RN_CHECKADV, /* fail when register slot a == position */
  RN_SETI32,   /* register slot a = b */
  RN_LOOPCNT,  /* --slot a; jump to target unless it reached 0 */
  RN_LOOPSPLIT, /* --slot a; loop while > b, then split (chk: empty check) */
};

typedef struct {
  uint8_t op;
  uint8_t greedy;
  uint8_t possessive;
  uint8_t chk;
  int a, b; /* LOOP: min, max; SAVE: slot; RESET: first/last slot; STR: length */
  int target;
  const uint8_t *tab; /* CLASS/LOOP: 128-entry table */
  const uint8_t *str; /* STR bytes */
} RnOp;

typedef struct ScrReNative {
  RnOp *ops;
  int nops;
  uint8_t *tabs; /* backing store for every table and literal run */
  int ncap;      /* capture pairs, including the whole match */
  int nslots;    /* 2 * ncap capture slots, then the loop registers */
  bool sticky;
  bool first_any; /* the program may match without consuming a first byte */
  bool first_bol; /* some path is anchored at position 0 */
  int first_byte; /* the only byte that can start a match, or -1 */
  uint8_t first[128];
} ScrReNative;

static uint32_t rn_u16(const uint8_t *p) {
  uint16_t v;
  memcpy(&v, p, sizeof v);
  return v;
}

static uint32_t rn_u32(const uint8_t *p) {
  uint32_t v;
  memcpy(&v, p, sizeof v);
  return v;
}

static bool rn_single_char_op(int opcode) {
  switch (opcode) {
    case SCR_REOP_char: case SCR_REOP_char_i: case SCR_REOP_char32: case SCR_REOP_char32_i:
    case SCR_REOP_dot: case SCR_REOP_any: case SCR_REOP_space: case SCR_REOP_not_space:
    case SCR_REOP_range: case SCR_REOP_range_i: case SCR_REOP_range32: case SCR_REOP_range32_i:
      return true;
    default:
      return false;
  }
}

/* The interpreter's own predicate for one ASCII code unit (see
 * lre_exec_backtrack's char/range/dot/space cases). */
RN_ONCE static bool rn_char_matches(const uint8_t *ins, uint32_t c, bool unicode) {
  int opcode = ins[0];
  switch (opcode) {
    case SCR_REOP_char: return c == rn_u16(ins + 1);
    case SCR_REOP_char_i: return (uint32_t)lre_canonicalize(c, unicode) == rn_u16(ins + 1);
    case SCR_REOP_char32: return c == rn_u32(ins + 1);
    case SCR_REOP_char32_i: return (uint32_t)lre_canonicalize(c, unicode) == rn_u32(ins + 1);
    case SCR_REOP_dot: return c != '\n' && c != '\r';
    case SCR_REOP_any: return true;
    case SCR_REOP_space: return lre_is_space(c) != 0;
    case SCR_REOP_not_space: return lre_is_space(c) == 0;
    case SCR_REOP_range:
    case SCR_REOP_range_i: {
      uint32_t cc = opcode == SCR_REOP_range_i ? (uint32_t)lre_canonicalize(c, unicode) : c;
      int n = (int)rn_u16(ins + 1);
      for (int i = 0; i < n; i++) {
        if (cc >= rn_u16(ins + 3 + 4 * i) && cc <= rn_u16(ins + 3 + 4 * i + 2)) return true;
      }
      return false;
    }
    case SCR_REOP_range32:
    case SCR_REOP_range32_i: {
      uint32_t cc = opcode == SCR_REOP_range32_i ? (uint32_t)lre_canonicalize(c, unicode) : c;
      int n = (int)rn_u16(ins + 1);
      for (int i = 0; i < n; i++) {
        if (cc >= rn_u32(ins + 3 + 8 * i) && cc <= rn_u32(ins + 3 + 8 * i + 4)) return true;
      }
      return false;
    }
    default:
      return false;
  }
}

RN_ONCE static int rn_ins_len(const uint8_t *p, const uint8_t *end) {
  int opcode = p[0];
  if (opcode <= 0 || opcode >= SCR_REOP_COUNT) return -1;
  int len = scr_reop_size[opcode];
  if (opcode == SCR_REOP_range || opcode == SCR_REOP_range_i) {
    if (end - p < 3) return -1;
    len += (int)rn_u16(p + 1) * 4;
  } else if (opcode == SCR_REOP_range32 || opcode == SCR_REOP_range32_i) {
    if (end - p < 3) return -1;
    len += (int)rn_u16(p + 1) * 8;
  } else if (opcode >= SCR_REOP_back_reference && opcode <= SCR_REOP_backward_back_reference_i) {
    if (end - p < 2) return -1;
    len += p[1];
  }
  if (len > end - p) return -1;
  return len;
}

/* Absolute body offset of a 5-byte jump's target (offset relative to the
 * end of the instruction, as lre_exec_backtrack reads it). */
static int rn_jump(const uint8_t *body, int off) {
  return off + 5 + (int32_t)rn_u32(body + off + 1);
}

/* Target of a counted loop: `loop r, rel32` jumps from off+6,
 * `loop_split r, limit, rel32` from off+10. */
static int rn_loop_jump(const uint8_t *body, int off) {
  if (body[off] == SCR_REOP_loop) return off + 6 + (int32_t)rn_u32(body + off + 2);
  return off + 10 + (int32_t)rn_u32(body + off + 6);
}

/* First-byte analysis from op `start`: which bytes can the first consumed
 * character be, whether a path is anchored at position 0, and whether a
 * path can reach the match without consuming. Zero-width assertions are
 * transparent (they only restrict positions further).
 *
 * The walk is iterative: split targets go on `work` (nops + 1 entries)
 * instead of the C stack, because a flat pattern such as a long run of empty
 * alternatives chains one split per alternative and would otherwise recurse
 * once per alternative while the regex is constructed. Every op is processed
 * at most once (`visited`), so each split pushes at most one entry, and the
 * accumulated set/any/bol do not depend on the visiting order. */
RN_ONCE static void rn_first(const ScrReNative *p, int start, uint8_t *visited, int *work,
                             uint8_t *set, bool *any, bool *bol) {
  int top = 0;
  work[top++] = start;
  while (top > 0) {
    int i = work[--top];
    bool stop = false;
    while (!stop && i >= 0 && i < p->nops && !visited[i]) {
      visited[i] = 1;
      const RnOp *op = &p->ops[i];
      switch (op->op) {
        case RN_CLASS:
          for (int c = 0; c < 128; c++) set[c] |= op->tab[c];
          stop = true;
          break;
        case RN_STR:
          set[op->str[0]] = 1;
          stop = true;
          break;
        case RN_LOOP:
          for (int c = 0; c < 128; c++) set[c] |= op->tab[c];
          if (op->a > 0) stop = true;
          else i++;
          break;
        case RN_BOL:
          *bol = true;
          stop = true;
          break;
        case RN_GOTO:
          i = op->target;
          break;
        case RN_SPLIT_NEXT:
        case RN_SPLIT_GOTO:
        case RN_LOOPCNT:
        case RN_LOOPSPLIT:
          if (top <= p->nops) work[top++] = op->target;
          i++;
          break;
        case RN_MATCH:
          *any = true;
          stop = true;
          break;
        default: /* SAVE, RESET, BOL_M, EOL, EOL_M, WORDB, NWORDB, SETPOS, CHECKADV, SETI32 */
          i++;
          break;
      }
    }
  }
}

RN_ONCE static void scr_re_native_free(ScrReNative *p) {
  if (!p) return;
  free(p->ops);
  free(p->tabs);
  free(p);
}

/* Translate libregexp bytecode, or NULL when the pattern uses anything
 * outside the subset (callers keep lre_exec). */
RN_ONCE static ScrReNative *scr_re_native_build(const uint8_t *bc) {
  int flags = (int)rn_u16(bc);
  bool unicode = (flags & (LRE_FLAG_UNICODE | LRE_FLAG_UNICODE_SETS)) != 0;
  int blen = (int)rn_u32(bc + 4);
  const uint8_t *body = bc + SCR_RE_HEADER_LEN;
  const uint8_t *end = body + blen;
  int start = 0;
  if (!(flags & LRE_FLAG_STICKY)) {
    /* split_goto_first +6; any; goto -11 — the search prefix. */
    if (blen < 11 || body[0] != SCR_REOP_split_goto_first || rn_u32(body + 1) != 6 ||
        body[5] != SCR_REOP_any || body[6] != SCR_REOP_goto || (int32_t)rn_u32(body + 7) != -11)
      return NULL;
    start = 11;
  }

  /* Decode instruction boundaries. */
  int cap = 16, n = 0;
  int *offs = malloc((size_t)cap * sizeof *offs);
  int *map = malloc(((size_t)blen + 1) * sizeof *map);
  if (!offs || !map) goto fail_alloc;
  for (int k = 0; k <= blen; k++) map[k] = -1;
  for (int off = start; off < blen;) {
    int len = rn_ins_len(body + off, end);
    if (len < 0) goto fail_alloc;
    if (n + 1 >= cap) {
      cap *= 2;
      int *grown = realloc(offs, (size_t)cap * sizeof *offs);
      if (!grown) goto fail_alloc;
      offs = grown;
    }
    offs[n++] = off;
    off += len;
  }
  offs[n] = blen;

  ScrReNative *p = calloc(1, sizeof *p);
  if (!p) goto fail_alloc;
  p->ncap = bc[2];
  p->nslots = 2 * bc[2] + bc[3];
  p->sticky = (flags & LRE_FLAG_STICKY) != 0;
  p->ops = calloc((size_t)n + 1, sizeof *p->ops);
  /* Upper bound: one table per instruction, plus one literal byte each. */
  p->tabs = malloc((size_t)n * 129 + 1);
  if (!p->ops || !p->tabs) goto fail;
  size_t tab_used = 0;

  /* Jump-target offsets, resolved after emission. Interior instructions of a
   * fused construct must never be targets: map[] marks them -2. */
  for (int k = 0; k < n;) {
    int off = offs[k];
    const uint8_t *ins = body + off;
    int opcode = ins[0];
    RnOp *op = &p->ops[p->nops];
    memset(op, 0, sizeof *op);
    int used = 1;
#define RN_OP_AT(j) (k + (j) < n ? body[offs[k + (j)]] : -1)
    if (rn_single_char_op(opcode)) {
      int next = RN_OP_AT(1);
      if ((next == SCR_REOP_split_goto_first || next == SCR_REOP_split_next_first) &&
          rn_jump(body, offs[k + 1]) == off) {
        /* x; split -> x  ==  x+ (goto_first loops first: greedy) */
        op->op = RN_LOOP;
        op->a = 1;
        op->b = INT32_MAX;
        op->greedy = next == SCR_REOP_split_goto_first;
        used = 2;
      } else {
        op->op = RN_CLASS;
      }
      uint8_t *tab = p->tabs + tab_used;
      for (uint32_t c = 0; c < 128; c++) tab[c] = rn_char_matches(ins, c, unicode);
      tab_used += 128;
      op->tab = tab;
    } else if ((opcode == SCR_REOP_split_goto_first || opcode == SCR_REOP_split_next_first) &&
               k + 2 < n && rn_single_char_op(RN_OP_AT(1)) && RN_OP_AT(2) == SCR_REOP_goto &&
               rn_jump(body, off) == offs[k + 3] && rn_jump(body, offs[k + 2]) == off) {
      /* split -> end; x; goto split  ==  x* (next_first enters: greedy) */
      op->op = RN_LOOP;
      op->a = 0;
      op->b = INT32_MAX;
      op->greedy = opcode == SCR_REOP_split_next_first;
      used = 3;
    } else if ((opcode == SCR_REOP_split_goto_first || opcode == SCR_REOP_split_next_first) &&
               k + 1 < n && rn_single_char_op(RN_OP_AT(1)) && rn_jump(body, off) == offs[k + 2]) {
      /* split -> end; x  ==  x? */
      op->op = RN_LOOP;
      op->a = 0;
      op->b = 1;
      op->greedy = opcode == SCR_REOP_split_next_first;
      used = 2;
    } else if (opcode == SCR_REOP_set_i32 && k + 2 < n && rn_single_char_op(RN_OP_AT(1)) &&
               (RN_OP_AT(2) == SCR_REOP_loop || RN_OP_AT(2) == SCR_REOP_loop_split_goto_first ||
                RN_OP_AT(2) == SCR_REOP_loop_split_next_first) &&
               body[offs[k + 2] + 1] == ins[1] && rn_loop_jump(body, offs[k + 2]) == offs[k + 1]) {
      /* set_i32 r N; x; loop r -> x  ==  x{N}
       * set_i32 r N; x; loop_split r L -> x  ==  x{max(1,N-L),N}: the
       * counter drops after each x and loops unconditionally while it
       * exceeds L. (x{0,N} wraps this in a skip split with L == N.) */
      int count = (int32_t)rn_u32(ins + 2);
      const uint8_t *lp = body + offs[k + 2];
      if (count <= 0) goto fail;
      op->op = RN_LOOP;
      op->b = count;
      if (lp[0] == SCR_REOP_loop) {
        op->a = count;
        op->greedy = 1;
      } else {
        int limit = (int32_t)rn_u32(lp + 2);
        if (limit < 0 || limit > count) goto fail;
        op->a = count - limit > 1 ? count - limit : 1;
        op->greedy = lp[0] == SCR_REOP_loop_split_goto_first;
      }
      used = 3;
    } else {
      used = 1;
      switch (opcode) {
        case SCR_REOP_save_start:
        case SCR_REOP_save_end:
          if (ins[1] >= p->ncap) goto fail;
          op->op = RN_SAVE;
          op->a = 2 * ins[1] + (opcode == SCR_REOP_save_end);
          break;
        case SCR_REOP_save_reset:
          if (ins[2] >= p->ncap || ins[1] > ins[2]) goto fail;
          op->op = RN_RESET;
          op->a = 2 * ins[1];
          op->b = 2 * ins[2] + 1;
          break;
        case SCR_REOP_split_goto_first:
          op->op = RN_SPLIT_GOTO;
          op->target = rn_jump(body, off);
          break;
        case SCR_REOP_split_next_first:
          op->op = RN_SPLIT_NEXT;
          op->target = rn_jump(body, off);
          break;
        case SCR_REOP_goto:
          op->op = RN_GOTO;
          op->target = rn_jump(body, off);
          break;
        case SCR_REOP_line_start: op->op = RN_BOL; break;
        case SCR_REOP_line_start_m: op->op = RN_BOL_M; break;
        case SCR_REOP_line_end: op->op = RN_EOL; break;
        case SCR_REOP_line_end_m: op->op = RN_EOL_M; break;
        /* the _i forms differ only for U+017F and U+212A */
        case SCR_REOP_word_boundary:
        case SCR_REOP_word_boundary_i: op->op = RN_WORDB; break;
        case SCR_REOP_not_word_boundary:
        case SCR_REOP_not_word_boundary_i: op->op = RN_NWORDB; break;
        case SCR_REOP_match: op->op = RN_MATCH; break;
        case SCR_REOP_set_char_pos:
        case SCR_REOP_check_advance:
          if (2 * p->ncap + ins[1] >= p->nslots) goto fail;
          op->op = opcode == SCR_REOP_set_char_pos ? RN_SETPOS : RN_CHECKADV;
          op->a = 2 * p->ncap + ins[1];
          break;
        case SCR_REOP_set_i32:
          if (2 * p->ncap + ins[1] >= p->nslots || (int32_t)rn_u32(ins + 2) < 0) goto fail;
          op->op = RN_SETI32;
          op->a = 2 * p->ncap + ins[1];
          op->b = (int32_t)rn_u32(ins + 2);
          break;
        case SCR_REOP_loop:
          if (2 * p->ncap + ins[1] >= p->nslots) goto fail;
          op->op = RN_LOOPCNT;
          op->a = 2 * p->ncap + ins[1];
          op->target = rn_loop_jump(body, off);
          break;
        case SCR_REOP_loop_split_goto_first:
        case SCR_REOP_loop_split_next_first:
        case SCR_REOP_loop_check_adv_split_goto_first:
        case SCR_REOP_loop_check_adv_split_next_first:
          op->chk = opcode == SCR_REOP_loop_check_adv_split_goto_first ||
                    opcode == SCR_REOP_loop_check_adv_split_next_first;
          /* the empty check reads the register after the counter */
          if (2 * p->ncap + ins[1] + op->chk >= p->nslots) goto fail;
          op->op = RN_LOOPSPLIT;
          op->a = 2 * p->ncap + ins[1];
          op->b = (int32_t)rn_u32(ins + 2);
          op->greedy = opcode == SCR_REOP_loop_split_goto_first ||
                       opcode == SCR_REOP_loop_check_adv_split_goto_first;
          op->target = rn_loop_jump(body, off);
          break;
        default:
          goto fail;
      }
    }
    if (op->op == RN_LOOP && op->tab == NULL) {
      /* fused forms whose character op is second */
      const uint8_t *x = body + offs[k + 1];
      uint8_t *tab = p->tabs + tab_used;
      for (uint32_t c = 0; c < 128; c++) tab[c] = rn_char_matches(x, c, unicode);
      tab_used += 128;
      op->tab = tab;
    }
    map[off] = p->nops;
    for (int j = 1; j < used; j++) map[offs[k + j]] = -2;
    p->nops++;
    k += used;
#undef RN_OP_AT
  }
  map[blen] = -1;

  /* Resolve jump targets. */
  for (int i = 0; i < p->nops; i++) {
    RnOp *op = &p->ops[i];
    if (op->op == RN_GOTO || op->op == RN_SPLIT_NEXT || op->op == RN_SPLIT_GOTO ||
        op->op == RN_LOOPCNT || op->op == RN_LOOPSPLIT) {
      if (op->target < 0 || op->target >= blen || map[op->target] < 0) goto fail;
      op->target = map[op->target];
    }
  }

  /* Fuse runs of single-byte literals (CLASS with one member) that no jump
   * enters into RN_STR. */
  {
    uint8_t *targeted = calloc((size_t)p->nops + 1, 1);
    if (!targeted) goto fail;
    for (int i = 0; i < p->nops; i++) {
      RnOp *op = &p->ops[i];
      if (op->op == RN_GOTO || op->op == RN_SPLIT_NEXT || op->op == RN_SPLIT_GOTO ||
          op->op == RN_LOOPCNT || op->op == RN_LOOPSPLIT)
        targeted[op->target] = 1;
    }
    int *remap = malloc(((size_t)p->nops + 1) * sizeof *remap);
    if (!remap) {
      free(targeted);
      goto fail;
    }
    int out = 0;
    for (int i = 0; i < p->nops;) {
      int run = 0;
      if (p->ops[i].op == RN_CLASS) {
        for (int j = i; j < p->nops && p->ops[j].op == RN_CLASS && (j == i || !targeted[j]); j++) {
          int count = 0;
          for (int c = 0; c < 128; c++) count += p->ops[j].tab[c];
          if (count != 1) break;
          run++;
        }
      }
      remap[i] = out;
      if (run >= 2) {
        uint8_t *bytes = p->tabs + tab_used;
        for (int j = 0; j < run; j++) {
          for (int c = 0; c < 128; c++) {
            if (p->ops[i + j].tab[c]) bytes[j] = (uint8_t)c;
          }
          if (j > 0) remap[i + j] = -1;
        }
        tab_used += (size_t)run;
        RnOp fused = {0};
        fused.op = RN_STR;
        fused.a = run;
        fused.str = bytes;
        p->ops[out++] = fused;
        i += run;
      } else {
        p->ops[out++] = p->ops[i];
        i++;
      }
    }
    remap[p->nops] = out;
    for (int i = 0; i < out; i++) {
      RnOp *op = &p->ops[i];
      if (op->op == RN_GOTO || op->op == RN_SPLIT_NEXT || op->op == RN_SPLIT_GOTO ||
          op->op == RN_LOOPCNT || op->op == RN_LOOPSPLIT)
        op->target = remap[op->target];
    }
    p->nops = out;
    free(remap);
    free(targeted);
  }

  /* First-byte prefilter. */
  {
    uint8_t *visited = calloc((size_t)p->nops + 1, 1);
    int *work = malloc(((size_t)p->nops + 1) * sizeof *work);
    if (!visited || !work) {
      free(visited);
      free(work);
      goto fail;
    }
    memset(p->first, 0, sizeof p->first);
    rn_first(p, 0, visited, work, p->first, &p->first_any, &p->first_bol);
    p->first_byte = -1;
    int count = 0;
    for (int c = 0; c < 128; c++) {
      if (p->first[c]) {
        count++;
        p->first_byte = c;
      }
    }
    if (count != 1) p->first_byte = -1;

    /* Possessive greedy loops: when no continuation path can start with a
     * byte of the loop's class (and none can match without consuming),
     * giving characters back can never succeed. */
    for (int i = 0; i < p->nops; i++) {
      RnOp *op = &p->ops[i];
      if (op->op != RN_LOOP || !op->greedy || op->a == op->b) continue;
      /* A continuation of saves and then the match always succeeds on the
       * first attempt, so the loop is never re-entered. */
      int next = i + 1;
      while (next < p->nops && p->ops[next].op == RN_SAVE) next++;
      if (next < p->nops && p->ops[next].op == RN_MATCH) {
        op->possessive = 1;
        continue;
      }
      uint8_t follow[128] = {0};
      bool any = false, bol = false;
      memset(visited, 0, (size_t)p->nops + 1);
      rn_first(p, i + 1, visited, work, follow, &any, &bol);
      if (any || bol) continue;
      bool disjoint = true;
      for (int c = 0; c < 128; c++) {
        if (follow[c] && op->tab[c]) {
          disjoint = false;
          break;
        }
      }
      op->possessive = disjoint;
    }
    free(visited);
    free(work);
  }
  free(offs);
  free(map);
  return p;

fail:
  scr_re_native_free(p);
fail_alloc:
  free(offs);
  free(map);
  return NULL;
}

/* ── execution ─────────────────────────────────────────────────────────── */

typedef struct {
  int kind; /* 0 split alternative, 1 greedy loop give-back, 2 lazy loop extend */
  int pc;
  int pos;
  int undo;
  int count;
} RnFrame;

typedef struct {
  int slot;
  int old;
} RnUndo;

typedef struct {
  RnFrame *frames;
  int nframes, frames_cap;
  RnUndo *undo;
  int nundo, undo_cap;
  RnFrame frames_buf[64];
  RnUndo undo_buf[128];
} RnStack;

static bool rn_grow(void **buf, int *cap, size_t elem, void *inline_buf) {
  int ncap = *cap * 2;
  void *grown;
  if (*buf == inline_buf) {
    grown = malloc((size_t)ncap * elem);
    if (grown) memcpy(grown, *buf, (size_t)*cap * elem);
  } else {
    grown = realloc(*buf, (size_t)ncap * elem);
  }
  if (!grown) return false;
  *buf = grown;
  *cap = ncap;
  return true;
}

static inline bool rn_word(const uint8_t *s, int len, int i) {
  return i >= 0 && i < len && lre_is_word_byte(s[i]);
}

/* One anchored attempt at `pos`. Returns 1 on match (cap filled), 0 on
 * failure, -1 on allocation failure. */
static int rn_run(const ScrReNative *p, int *cap, const uint8_t *s, int len, int pos,
                  RnStack *st) {
  const RnOp *ops = p->ops;
  int pc = 0;
  st->nframes = 0;
  st->nundo = 0;
#define RN_PUSH_FRAME(k, tpc, tpos, cnt)                                              \
  do {                                                                                \
    if (st->nframes == st->frames_cap &&                                              \
        !rn_grow((void **)&st->frames, &st->frames_cap, sizeof(RnFrame), st->frames_buf)) \
      return -1;                                                                      \
    RnFrame *f_ = &st->frames[st->nframes++];                                         \
    f_->kind = (k);                                                                   \
    f_->pc = (tpc);                                                                   \
    f_->pos = (tpos);                                                                 \
    f_->undo = st->nundo;                                                             \
    f_->count = (cnt);                                                                \
  } while (0)
#define RN_SET_CAP(slot_, value_)                                                     \
  do {                                                                                \
    if (st->nframes > 0) {                                                            \
      if (st->nundo == st->undo_cap &&                                                \
          !rn_grow((void **)&st->undo, &st->undo_cap, sizeof(RnUndo), st->undo_buf))  \
        return -1;                                                                    \
      st->undo[st->nundo].slot = (slot_);                                             \
      st->undo[st->nundo].old = cap[slot_];                                           \
      st->nundo++;                                                                    \
    }                                                                                 \
    cap[slot_] = (value_);                                                            \
  } while (0)
  for (;;) {
    const RnOp *op = &ops[pc];
    switch (op->op) {
      case RN_CLASS:
        if (pos >= len || !op->tab[s[pos]]) goto fail;
        pos++;
        pc++;
        continue;
      case RN_STR:
        if (len - pos < op->a || s[pos] != op->str[0] || memcmp(s + pos, op->str, (size_t)op->a) != 0)
          goto fail;
        pos += op->a;
        pc++;
        continue;
      case RN_LOOP: {
        int min = op->a, max = op->b;
        const uint8_t *tab = op->tab;
        if (op->greedy) {
          int limit = len - pos < max ? len - pos : max;
          int k = 0;
          while (k < limit && tab[s[pos + k]]) k++;
          if (k < min) goto fail;
          if (k > min && !op->possessive) RN_PUSH_FRAME(1, pc, pos, k);
          pos += k;
        } else {
          if (len - pos < min) goto fail;
          for (int k = 0; k < min; k++) {
            if (!tab[s[pos + k]]) goto fail;
          }
          pos += min;
          if (min < max) RN_PUSH_FRAME(2, pc, pos - min, min);
        }
        pc++;
        continue;
      }
      case RN_SAVE:
        RN_SET_CAP(op->a, pos);
        pc++;
        continue;
      case RN_RESET:
        for (int slot = op->a; slot <= op->b; slot++) RN_SET_CAP(slot, -1);
        pc++;
        continue;
      case RN_SPLIT_NEXT:
        RN_PUSH_FRAME(0, op->target, pos, 0);
        pc++;
        continue;
      case RN_SPLIT_GOTO:
        RN_PUSH_FRAME(0, pc + 1, pos, 0);
        pc = op->target;
        continue;
      case RN_GOTO:
        pc = op->target;
        continue;
      case RN_BOL:
        if (pos != 0) goto fail;
        pc++;
        continue;
      case RN_BOL_M:
        if (pos != 0 && s[pos - 1] != '\n' && s[pos - 1] != '\r') goto fail;
        pc++;
        continue;
      case RN_EOL:
        if (pos != len) goto fail;
        pc++;
        continue;
      case RN_EOL_M:
        if (pos != len && s[pos] != '\n' && s[pos] != '\r') goto fail;
        pc++;
        continue;
      case RN_WORDB:
      case RN_NWORDB: {
        bool boundary = rn_word(s, len, pos - 1) != rn_word(s, len, pos);
        if (boundary != (op->op == RN_WORDB)) goto fail;
        pc++;
        continue;
      }
      case RN_MATCH:
        return 1;
      case RN_SETPOS:
        RN_SET_CAP(op->a, pos);
        pc++;
        continue;
      case RN_CHECKADV:
        if (cap[op->a] == pos) goto fail;
        pc++;
        continue;
      case RN_SETI32:
        RN_SET_CAP(op->a, op->b);
        pc++;
        continue;
      case RN_LOOPCNT: {
        int v = cap[op->a] - 1;
        RN_SET_CAP(op->a, v);
        pc = v != 0 ? op->target : pc + 1;
        continue;
      }
      case RN_LOOPSPLIT: {
        /* lre_exec_backtrack's loop_split / loop_check_adv_split */
        int v = cap[op->a] - 1;
        RN_SET_CAP(op->a, v);
        if (v > op->b) {
          pc = op->target;
          continue;
        }
        if (op->chk && cap[op->a + 1] == pos && v != op->b) goto fail;
        if (v != 0) {
          if (op->greedy) {
            RN_PUSH_FRAME(0, pc + 1, pos, 0);
            pc = op->target;
          } else {
            RN_PUSH_FRAME(0, op->target, pos, 0);
            pc++;
          }
        } else {
          pc++;
        }
        continue;
      }
    }
  fail:
    for (;;) {
      if (st->nframes == 0) return 0;
      RnFrame *f = &st->frames[st->nframes - 1];
      while (st->nundo > f->undo) {
        st->nundo--;
        cap[st->undo[st->nundo].slot] = st->undo[st->nundo].old;
      }
      if (f->kind == 0) {
        pc = f->pc;
        pos = f->pos;
        st->nframes--;
        break;
      }
      const RnOp *lp = &ops[f->pc];
      if (f->kind == 1) {
        /* give back one character */
        f->count--;
        pc = f->pc + 1;
        pos = f->pos + f->count;
        if (f->count <= lp->a) st->nframes--;
        break;
      }
      /* lazy: take one more character */
      int at = f->pos + f->count;
      if (f->count < lp->b && at < len && lp->tab[s[at]]) {
        f->count++;
        pc = f->pc + 1;
        pos = at + 1;
        if (f->count >= lp->b) st->nframes--;
        break;
      }
      st->nframes--;
    }
  }
#undef RN_PUSH_FRAME
#undef RN_SET_CAP
}

/* Search (or, for sticky patterns, an anchored attempt) from `start` in a
 * one-byte subject. Same contract as lre_exec: returns 1 on a match with
 * capture[0 .. 2*ncap) set to pointers into `s` (NULL when unset), 0 when
 * nothing matches, < 0 on allocation failure. */
/* The next position >= at where an unanchored match can begin, or -1. */
static int rn_next(const ScrReNative *p, const uint8_t *s, int at, int len) {
  if (p->first_any) return at <= len ? at : -1;
  if (at == 0 && p->first_bol) return 0;
  if (at >= len) return -1;
  if (p->first_byte >= 0) {
    const uint8_t *hit = memchr(s + at, p->first_byte, (size_t)(len - at));
    return hit ? (int)(hit - s) : -1;
  }
  for (; at < len; at++) {
    if (p->first[s[at]]) return at;
  }
  return -1;
}

static int scr_re_native_exec(const ScrReNative *p, uint8_t **capture, const uint8_t *s,
                              int start, int len) {
  int cap_buf[64];
  int *cap = p->nslots <= 64 ? cap_buf : malloc((size_t)p->nslots * sizeof *cap);
  if (!cap) return -1;
  RnStack st;
  st.frames = st.frames_buf;
  st.frames_cap = (int)(sizeof st.frames_buf / sizeof st.frames_buf[0]);
  st.undo = st.undo_buf;
  st.undo_cap = (int)(sizeof st.undo_buf / sizeof st.undo_buf[0]);
  int rc = 0;
  for (int at = start; at <= len; at++) {
    if (!p->sticky && (at = rn_next(p, s, at, len)) < 0) break;
    cap[0] = cap[1] = -1; /* nslots >= 2: the whole-match pair */
    for (int i = 2; i < p->nslots; i++) cap[i] = -1;
    rc = rn_run(p, cap, s, len, at, &st);
    if (rc != 0 || p->sticky) break;
  }
  if (rc == 1) {
    for (int i = 0; i < 2 * p->ncap; i++)
      capture[i] = cap[i] < 0 ? NULL : (uint8_t *)(s + cap[i]);
  }
  if (st.frames != st.frames_buf) free(st.frames);
  if (st.undo != st.undo_buf) free(st.undo);
  if (cap != cap_buf) free(cap);
  return rc;
}

#endif /* SCR_REGEX_NATIVE_H */
