/* scr_unwind_raise: the native unwind of the unwinding exception ABI of
 * emitted functions (the compiler's unwind-abi.ts), and scr_unwind_resume,
 * which emitted landing pads call to continue it. Linux (glibc and musl)
 * only; elsewhere this unit is empty.
 *
 * Emitted landing pads are cleanups: they release the frame's references
 * and then either take the exception (a handler of theirs, or a frame on
 * the pending-flag ABI that returns with it pending) or resume the unwind.
 * So the unwind is a single pass through every landing pad; the exception
 * itself stays in the active cell.
 *
 * On x86-64 the unwind walks with plans cached per return address. The
 * first raise through a return address finds the function's FDE through
 * the .eh_frame_hdr of the object that contains it, runs the CFI up to the
 * call, and finds the call site's landing pad in the LSDA. The plan records
 * how to compute the frame's CFA, where each callee-saved register is
 * saved, and the landing pad; later raises only look plans up. A landing
 * pad runs with rax holding the raise's token and rdx 0 (a cleanup). When a
 * frame's FDE uses CFI or encodings the plans do not express, or a return
 * address has no FDE, the unwind goes on from the frame the walk started at
 * with libgcc's forced unwind, as on other Linux targets. */
#include "scr_runtime.h"

#if defined(__linux__) && !defined(__ANDROID__) && !defined(__wasi__)
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unwind.h>

/* Weak, so the runtime unit alone does not link the unwinder into every
 * program: programs that raise reference the personality routine from
 * their landing pads, and its unit references the unwinder's entry points,
 * which link it in. */
#pragma weak _Unwind_ForcedUnwind
#pragma weak _Unwind_GetCFA
#pragma weak _Unwind_Resume

#if defined(__SANITIZE_ADDRESS__)
#define SCR_UNWIND_ASAN 1
#elif defined(__has_feature)
#if __has_feature(address_sanitizer)
#define SCR_UNWIND_ASAN 1
#endif
#endif
#ifdef SCR_UNWIND_ASAN
#include <sanitizer/asan_interface.h>
#endif

#ifdef SCR_UNWIND_ASAN
/* The lowest stack address the unwind has not cleared yet. The unwind
 * outlives the frame that started it: landing pads resume it. */
static SCR_TL uintptr_t scr_unwind_low;
#endif

static _Unwind_Reason_Code scr_unwind_stop(int version, _Unwind_Action actions,
                                           _Unwind_Exception_Class cls,
                                           struct _Unwind_Exception *exc,
                                           struct _Unwind_Context *context, void *arg) {
  (void)version;
  (void)cls;
  (void)exc;
#ifdef SCR_UNWIND_ASAN
  /* The frames this unwind passes never return, so it clears their
   * redzones' shadow itself. Emitted code calls scr_unwind_raise as an
   * ordinary function: the sanitizer's hook before no-return calls needs
   * stack bounds, which fiber stacks do not report. */
  uintptr_t cfa = _Unwind_GetCFA(context);
  if (cfa > scr_unwind_low) {
    __asan_unpoison_memory_region((void *)scr_unwind_low, cfa - scr_unwind_low);
    scr_unwind_low = cfa;
  }
#else
  (void)context;
#endif
  (void)arg;
  if (actions & _UA_END_OF_STACK) {
    fputs("scriptc: an exception unwound past the program's outermost frame\n", stderr);
    abort();
  }
  return _URC_NO_REASON;
}

static SCR_TL struct _Unwind_Exception scr_unwind_exception;

/* libgcc's forced unwind, from the caller of the function that calls this.
 * It does not return; it is not declared noreturn, so sanitized builds call
 * no sanitizer hook before it (see scr_unwind_stop). */
static __attribute__((noinline)) void scr_unwind_forced(void) {
  struct _Unwind_Exception *exc = &scr_unwind_exception;
  memset(exc, 0, sizeof *exc);
  exc->exception_class = 0x5343524950540000ull; /* "SCRIPT\0\0" */
#ifdef SCR_UNWIND_ASAN
  scr_unwind_low = (uintptr_t)__builtin_frame_address(0);
#endif
  if (_Unwind_ForcedUnwind != NULL) _Unwind_ForcedUnwind(exc, scr_unwind_stop, NULL);
  fputs("scriptc: the native unwinder could not raise an exception\n", stderr);
  abort();
}

#if defined(__x86_64__)
#include <link.h>

/* DWARF register numbers. */
enum {
  SCR_UNW_RBX = 3,
  SCR_UNW_RBP = 6,
  SCR_UNW_RSP = 7,
  SCR_UNW_R12 = 12,
  SCR_UNW_R13 = 13,
  SCR_UNW_R14 = 14,
  SCR_UNW_R15 = 15,
  SCR_UNW_RA = 16,
  SCR_UNW_REGS = 17
};

/* The callee-saved registers a plan restores, in the order of its bits. */
static const uint8_t scr_unwind_callee[6] = {SCR_UNW_RBX, SCR_UNW_RBP, SCR_UNW_R12,
                                             SCR_UNW_R13, SCR_UNW_R14, SCR_UNW_R15};

typedef struct {
  uint64_t pc;      /* the return address the plan is for (0: an empty slot) */
  uint64_t pad;     /* the call site's landing pad, or 0 */
  int32_t cfa_off;  /* the CFA is cfa_reg's value plus cfa_off */
  uint8_t cfa_reg;  /* SCR_UNW_RSP or SCR_UNW_RBP */
  uint8_t saved;    /* bit i: scr_unwind_callee[i] is saved at CFA + off[i] * 8 */
  int8_t off[6];
  uint8_t fallback; /* the frame is left to libgcc's unwinder */
} ScrUnwindPlan;

_Static_assert(sizeof(ScrUnwindPlan) == 32, "a plan is half a cache line");

#define SCR_UNWIND_PLAN_BITS 14
#define SCR_UNWIND_PLAN_SLOTS (1u << SCR_UNWIND_PLAN_BITS)
static ScrUnwindPlan scr_unwind_plans[SCR_UNWIND_PLAN_SLOTS];
static const ScrUnwindPlan scr_unwind_fallback_plan = {.fallback = 1};
static size_t scr_unwind_plan_count;
/* Inserts take this lock; lookups take none. A plan is published by the
 * release store of its pc. */
static int scr_unwind_lock;

/* Reads a value in DWARF pointer encoding enc. datarel is the base of
 * datarel values (0 where they do not occur). Sets *bad for an encoding the
 * plans do not read, which includes indirect values. Like libgcc, a zero
 * value stays zero. */
static uint64_t scr_unwind_read(const uint8_t **p, uint8_t enc, uint64_t datarel, int *bad) {
  const uint8_t *start = *p;
  uint64_t v = 0;
  switch (enc & 0x0f) {
  case 0x00: /* absptr */
  case 0x04: /* udata8 */
  case 0x0c: /* sdata8 */
    memcpy(&v, *p, 8);
    *p += 8;
    break;
  case 0x01: { /* uleb128 */
    unsigned shift = 0;
    uint8_t b;
    do {
      b = *(*p)++;
      if (shift < 64) v |= (uint64_t)(b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    break;
  }
  case 0x02: {
    uint16_t x;
    memcpy(&x, *p, 2);
    *p += 2;
    v = x;
    break;
  }
  case 0x03: {
    uint32_t x;
    memcpy(&x, *p, 4);
    *p += 4;
    v = x;
    break;
  }
  case 0x0a: {
    int16_t x;
    memcpy(&x, *p, 2);
    *p += 2;
    v = (uint64_t)(int64_t)x;
    break;
  }
  case 0x0b: {
    int32_t x;
    memcpy(&x, *p, 4);
    *p += 4;
    v = (uint64_t)(int64_t)x;
    break;
  }
  default: /* sleb128 and unknown formats */
    *bad = 1;
    return 0;
  }
  if (v == 0) return 0;
  switch (enc & 0x70) {
  case 0x00:
    break;
  case 0x10: /* pcrel */
    v += (uint64_t)(uintptr_t)start;
    break;
  case 0x30: /* datarel */
    if (datarel == 0) *bad = 1;
    v += datarel;
    break;
  default:
    *bad = 1;
    return 0;
  }
  if (enc & 0x80) *bad = 1; /* indirect: read only through scr_unwind_skip */
  return v;
}

static uint64_t scr_unwind_uleb(const uint8_t **p) {
  int bad = 0;
  return scr_unwind_read(p, 0x01, 0, &bad);
}

static int64_t scr_unwind_sleb(const uint8_t **p) {
  int64_t v = 0;
  unsigned shift = 0;
  uint8_t b;
  do {
    b = *(*p)++;
    if (shift < 64) v |= (int64_t)((uint64_t)(b & 0x7f) << shift);
    shift += 7;
  } while (b & 0x80);
  if (shift < 64 && (b & 0x40)) v |= (int64_t)(~(uint64_t)0 << shift);
  return v;
}

/* A search for the loaded object that contains pc, and its .eh_frame_hdr
 * search table. */
typedef struct {
  uint64_t pc;
  const uint8_t *hdr;
  const uint8_t *table;
  size_t count;
} ScrUnwindObject;

static int scr_unwind_find_object(struct dl_phdr_info *info, size_t size, void *data) {
  (void)size;
  ScrUnwindObject *object = data;
  int contains = 0;
  const uint8_t *h = NULL;
  for (int i = 0; i < info->dlpi_phnum; i++) {
    const ElfW(Phdr) *phdr = &info->dlpi_phdr[i];
    uint64_t start = (uint64_t)info->dlpi_addr + phdr->p_vaddr;
    if (phdr->p_type == PT_LOAD && object->pc >= start && object->pc - start < phdr->p_memsz)
      contains = 1;
    else if (phdr->p_type == PT_GNU_EH_FRAME)
      h = (const uint8_t *)(uintptr_t)start;
  }
  if (!contains) return 0;
  /* Version 1 with the table LLVM's and GNU's linkers write: datarel
   * sdata4 pairs, sorted by initial location. */
  if (h != NULL && h[0] == 1 && h[1] != 0xff && h[2] != 0xff && h[3] == 0x3b) {
    int bad = 0;
    const uint8_t *p = h + 4;
    (void)scr_unwind_read(&p, h[1], (uint64_t)(uintptr_t)h, &bad);
    uint64_t count = scr_unwind_read(&p, h[2], (uint64_t)(uintptr_t)h, &bad);
    if (!bad) {
      object->hdr = h;
      object->table = p;
      object->count = (size_t)count;
    }
  }
  return 1;
}

/* The FDE whose initial location is the greatest one at or below pc in
 * the table of the object that contains pc. */
static const uint8_t *scr_unwind_find_fde(uint64_t pc) {
  ScrUnwindObject object = {.pc = pc};
  dl_iterate_phdr(scr_unwind_find_object, &object);
  if (object.table == NULL) return NULL;
  uint64_t base = (uint64_t)(uintptr_t)object.hdr;
  size_t lo = 0, hi = object.count;
  while (lo < hi) {
    size_t mid = lo + (hi - lo) / 2;
    int32_t start;
    memcpy(&start, object.table + mid * 8, 4);
    if (base + (uint64_t)(int64_t)start <= pc) lo = mid + 1;
    else hi = mid;
  }
  if (lo == 0) return NULL;
  int32_t fde;
  memcpy(&fde, object.table + (lo - 1) * 8 + 4, 4);
  return (const uint8_t *)(uintptr_t)(base + (uint64_t)(int64_t)fde);
}

#define SCR_UNWIND_UNSAVED INT32_MIN

typedef struct {
  uint64_t cfa_reg;
  int64_t cfa_off;
  int32_t saved[SCR_UNW_REGS]; /* CFA-relative offsets, or SCR_UNWIND_UNSAVED */
  uint64_t args_size;
} ScrUnwindRules;

/* Whether the plans track register reg: the callee-saved registers, the
 * stack pointer and the return address. */
static int scr_unwind_tracked(uint64_t reg) {
  return reg == SCR_UNW_RBX || reg == SCR_UNW_RBP || reg == SCR_UNW_RSP ||
         (reg >= SCR_UNW_R12 && reg <= SCR_UNW_RA);
}

static void scr_unwind_save(ScrUnwindRules *r, uint64_t reg, int64_t off, int *bad) {
  if (reg >= SCR_UNW_REGS) return; /* vector and other registers stay as they are */
  if (off < INT32_MIN + 1 || off > INT32_MAX) *bad = 1;
  else r->saved[reg] = (int32_t)off;
}

/* Runs CFI instructions up to the location pc. Sets *bad for an
 * instruction the plans do not express. */
static void scr_unwind_run_cfi(const uint8_t *p, const uint8_t *end, uint64_t code_align,
                               int64_t data_align, uint64_t loc, uint64_t pc, ScrUnwindRules *r,
                               const ScrUnwindRules *initial, int *bad) {
  ScrUnwindRules stack[8];
  int depth = 0;
  while (p < end && loc <= pc && !*bad) {
    uint8_t op = *p++;
    uint8_t low = op & 0x3f;
    switch (op & 0xc0) {
    case 0x40: /* advance_loc */
      loc += low * code_align;
      continue;
    case 0x80: /* offset */
      scr_unwind_save(r, low, (int64_t)scr_unwind_uleb(&p) * data_align, bad);
      continue;
    case 0xc0: /* restore */
      if (low < SCR_UNW_REGS) r->saved[low] = initial->saved[low];
      continue;
    default:
      break;
    }
    switch (op) {
    case 0x00: /* nop */
      break;
    case 0x02: /* advance_loc1 */
      loc += *p++ * code_align;
      break;
    case 0x03: { /* advance_loc2 */
      uint16_t d;
      memcpy(&d, p, 2);
      p += 2;
      loc += d * code_align;
      break;
    }
    case 0x04: { /* advance_loc4 */
      uint32_t d;
      memcpy(&d, p, 4);
      p += 4;
      loc += d * code_align;
      break;
    }
    case 0x05: { /* offset_extended */
      uint64_t reg = scr_unwind_uleb(&p);
      scr_unwind_save(r, reg, (int64_t)scr_unwind_uleb(&p) * data_align, bad);
      break;
    }
    case 0x06: { /* restore_extended */
      uint64_t reg = scr_unwind_uleb(&p);
      if (reg < SCR_UNW_REGS) r->saved[reg] = initial->saved[reg];
      break;
    }
    case 0x07: /* undefined */
    case 0x08: { /* same_value */
      uint64_t reg = scr_unwind_uleb(&p);
      if (op == 0x07 && scr_unwind_tracked(reg)) *bad = 1;
      else if (reg < SCR_UNW_REGS) r->saved[reg] = SCR_UNWIND_UNSAVED;
      break;
    }
    case 0x09: { /* register */
      uint64_t reg = scr_unwind_uleb(&p);
      (void)scr_unwind_uleb(&p);
      if (scr_unwind_tracked(reg)) *bad = 1;
      break;
    }
    case 0x0a: /* remember_state */
      if (depth == 8) *bad = 1;
      else stack[depth++] = *r;
      break;
    case 0x0b: { /* restore_state: the CFA rule and args size stay */
      if (depth == 0) {
        *bad = 1;
        break;
      }
      uint64_t args_size = r->args_size;
      *r = stack[--depth];
      r->args_size = args_size;
      break;
    }
    case 0x0c: /* def_cfa */
      r->cfa_reg = scr_unwind_uleb(&p);
      r->cfa_off = (int64_t)scr_unwind_uleb(&p);
      break;
    case 0x0d: /* def_cfa_register */
      r->cfa_reg = scr_unwind_uleb(&p);
      break;
    case 0x0e: /* def_cfa_offset */
      r->cfa_off = (int64_t)scr_unwind_uleb(&p);
      break;
    case 0x11: { /* offset_extended_sf */
      uint64_t reg = scr_unwind_uleb(&p);
      scr_unwind_save(r, reg, scr_unwind_sleb(&p) * data_align, bad);
      break;
    }
    case 0x12: /* def_cfa_sf */
      r->cfa_reg = scr_unwind_uleb(&p);
      r->cfa_off = scr_unwind_sleb(&p) * data_align;
      break;
    case 0x13: /* def_cfa_offset_sf */
      r->cfa_off = scr_unwind_sleb(&p) * data_align;
      break;
    case 0x2e: /* GNU_args_size */
      r->args_size = scr_unwind_uleb(&p);
      break;
    default: /* expressions, val_offset, set_loc and vendor instructions */
      *bad = 1;
      break;
    }
  }
}

/* The landing pad of the call site that contains pc in an LSDA, or 0. */
static uint64_t scr_unwind_lsda_pad(const uint8_t *p, uint64_t func_start, uint64_t pc, int *bad) {
  uint8_t lpstart_enc = *p++;
  uint64_t lpstart = func_start;
  if (lpstart_enc != 0xff) lpstart = scr_unwind_read(&p, lpstart_enc, 0, bad);
  uint8_t ttype_enc = *p++;
  if (ttype_enc != 0xff) (void)scr_unwind_uleb(&p);
  uint8_t cs_enc = *p++;
  uint64_t cs_len = scr_unwind_uleb(&p);
  const uint8_t *cs_end = p + cs_len;
  while (p < cs_end && !*bad) {
    uint64_t start = scr_unwind_read(&p, cs_enc, 0, bad);
    uint64_t len = scr_unwind_read(&p, cs_enc, 0, bad);
    uint64_t pad = scr_unwind_read(&p, cs_enc, 0, bad);
    (void)scr_unwind_uleb(&p); /* action */
    if (pc < func_start + start) return 0;
    if (pc < func_start + start + len) return pad ? lpstart + pad : 0;
  }
  return 0;
}

/* The personality routine of emitted functions; the walk reads their
 * LSDAs itself. Frames with any other personality are left to libgcc. */
extern _Unwind_Reason_Code __gcc_personality_v0(int, _Unwind_Action, _Unwind_Exception_Class,
                                                struct _Unwind_Exception *,
                                                struct _Unwind_Context *);
#pragma weak __gcc_personality_v0

/* Builds the plan of return address ra. */
static void scr_unwind_build(ScrUnwindPlan *plan, uint64_t ra) {
  memset(plan, 0, sizeof *plan);
  plan->fallback = 1;
  uint64_t pc = ra - 1; /* within the call instruction */
  const uint8_t *fde = scr_unwind_find_fde(pc);
  if (fde == NULL) return;
  uint32_t fde_len;
  memcpy(&fde_len, fde, 4);
  if (fde_len == 0 || fde_len == 0xffffffffu) return;
  const uint8_t *fde_end = fde + 4 + fde_len;
  int32_t cie_off;
  memcpy(&cie_off, fde + 4, 4);
  if (cie_off == 0) return;
  const uint8_t *cie = fde + 4 - cie_off;
  uint32_t cie_len;
  memcpy(&cie_len, cie, 4);
  if (cie_len == 0 || cie_len == 0xffffffffu) return;
  const uint8_t *cie_end = cie + 4 + cie_len;
  const uint8_t *q = cie + 8; /* past the length and the CIE id */
  uint8_t version = *q++;
  if (version != 1 && version != 3) return;
  const char *aug = (const char *)q;
  q += strlen(aug) + 1;
  uint64_t code_align = scr_unwind_uleb(&q);
  int64_t data_align = scr_unwind_sleb(&q);
  uint64_t ra_reg = version == 1 ? *q++ : scr_unwind_uleb(&q);
  if (ra_reg != SCR_UNW_RA) return;
  int bad = 0;
  uint8_t fde_enc = 0x00, lsda_enc = 0xff;
  if (aug[0] == 'z') {
    uint64_t aug_len = scr_unwind_uleb(&q);
    const uint8_t *aug_end = q + aug_len;
    for (const char *a = aug + 1; *a != '\0'; a++) {
      if (*a == 'R') {
        fde_enc = *q++;
      } else if (*a == 'L') {
        lsda_enc = *q++;
      } else if (*a == 'P') {
        uint8_t enc = *q++;
        uint64_t slot = scr_unwind_read(&q, enc & 0x7f, 0, &bad);
        uint64_t personality = slot;
        if ((enc & 0x80) && slot != 0) memcpy(&personality, (const void *)(uintptr_t)slot, 8);
        if (personality != (uint64_t)(uintptr_t)&__gcc_personality_v0) bad = 1;
      } else {
        return; /* signal frames and unknown augmentations */
      }
    }
    q = aug_end;
  } else if (aug[0] != '\0') {
    return;
  }
  if (bad) return;
  ScrUnwindRules initial = {.cfa_reg = SCR_UNW_RSP, .cfa_off = 8};
  for (int i = 0; i < SCR_UNW_REGS; i++) initial.saved[i] = SCR_UNWIND_UNSAVED;
  scr_unwind_run_cfi(q, cie_end, code_align, data_align, 0, UINT64_MAX, &initial, &initial, &bad);
  const uint8_t *f = fde + 8;
  uint64_t func_start = scr_unwind_read(&f, fde_enc, 0, &bad);
  uint64_t func_len = scr_unwind_read(&f, fde_enc & 0x0f, 0, &bad);
  if (bad || pc < func_start || pc - func_start >= func_len) return;
  const uint8_t *lsda = NULL;
  if (aug[0] == 'z') {
    uint64_t aug_len = scr_unwind_uleb(&f);
    const uint8_t *aug_end = f + aug_len;
    if (lsda_enc != 0xff && aug_len != 0)
      lsda = (const uint8_t *)(uintptr_t)scr_unwind_read(&f, lsda_enc, 0, &bad);
    f = aug_end;
  }
  ScrUnwindRules r = initial;
  scr_unwind_run_cfi(f, fde_end, code_align, data_align, func_start, pc, &r, &initial, &bad);
  if (bad || r.args_size != 0) return;
  if (r.cfa_reg != SCR_UNW_RSP && r.cfa_reg != SCR_UNW_RBP) return;
  if (r.cfa_off < INT32_MIN || r.cfa_off > INT32_MAX) return;
  if (r.saved[SCR_UNW_RA] != -8) return;
  uint8_t saved = 0;
  for (int i = 0; i < 6; i++) {
    int32_t o = r.saved[scr_unwind_callee[i]];
    if (o == SCR_UNWIND_UNSAVED) continue;
    if (o % 8 != 0 || o / 8 < INT8_MIN || o / 8 > INT8_MAX) return;
    saved |= (uint8_t)(1u << i);
    plan->off[i] = (int8_t)(o / 8);
  }
  uint64_t pad = lsda ? scr_unwind_lsda_pad(lsda, func_start, pc, &bad) : 0;
  if (bad) return;
  plan->cfa_reg = (uint8_t)r.cfa_reg;
  plan->cfa_off = (int32_t)r.cfa_off;
  plan->saved = saved;
  plan->pad = pad;
  plan->fallback = 0;
}

static uint64_t scr_unwind_hash(uint64_t ra) {
  return (ra * 0x9E3779B97F4A7C15ull) >> (64 - SCR_UNWIND_PLAN_BITS);
}

static __attribute__((noinline)) const ScrUnwindPlan *scr_unwind_insert(uint64_t ra) {
  while (__atomic_exchange_n(&scr_unwind_lock, 1, __ATOMIC_ACQUIRE))
    while (__atomic_load_n(&scr_unwind_lock, __ATOMIC_RELAXED)) __builtin_ia32_pause();
  const ScrUnwindPlan *result = &scr_unwind_fallback_plan;
  uint64_t h = scr_unwind_hash(ra);
  ScrUnwindPlan *slot = &scr_unwind_plans[h];
  while (slot->pc != 0 && slot->pc != ra) {
    h = (h + 1) & (SCR_UNWIND_PLAN_SLOTS - 1);
    slot = &scr_unwind_plans[h];
  }
  if (slot->pc == ra) {
    result = slot;
  } else if (scr_unwind_plan_count < SCR_UNWIND_PLAN_SLOTS / 4 * 3) {
    /* A full table leaves further return addresses to libgcc. */
    scr_unwind_plan_count++;
    ScrUnwindPlan built;
    scr_unwind_build(&built, ra);
    /* Lookups read pc atomically, so the plan's other fields are written
     * first and pc only by the release store that publishes them. */
    memcpy((char *)slot + sizeof slot->pc, (const char *)&built + sizeof built.pc,
           sizeof *slot - sizeof slot->pc);
    __atomic_store_n(&slot->pc, ra, __ATOMIC_RELEASE);
    result = slot;
  }
  __atomic_store_n(&scr_unwind_lock, 0, __ATOMIC_RELEASE);
  return result;
}

static const ScrUnwindPlan *scr_unwind_plan(uint64_t ra) {
  uint64_t h = scr_unwind_hash(ra);
  for (;;) {
    const ScrUnwindPlan *plan = &scr_unwind_plans[h];
    uint64_t pc = __atomic_load_n(&plan->pc, __ATOMIC_ACQUIRE);
    if (pc == ra) return plan;
    if (pc == 0) return scr_unwind_insert(ra);
    h = (h + 1) & (SCR_UNWIND_PLAN_SLOTS - 1);
  }
}

/* Restores the callee-saved registers and the stack pointer of regs
 * (indexed by DWARF number) and jumps to the landing pad with rax holding
 * the token and rdx 0. */
static _Noreturn __attribute__((naked)) void scr_unwind_install(const uint64_t *regs, uint64_t pad,
                                                                const void *token) {
  __asm__ volatile("movq %rdx, %rax\n\t"
                   "movq %rsi, %r11\n\t"
                   "movq 24(%rdi), %rbx\n\t"
                   "movq 48(%rdi), %rbp\n\t"
                   "movq 96(%rdi), %r12\n\t"
                   "movq 104(%rdi), %r13\n\t"
                   "movq 112(%rdi), %r14\n\t"
                   "movq 120(%rdi), %r15\n\t"
                   "movq 56(%rdi), %rsp\n\t"
                   "xorl %edx, %edx\n\t"
                   "jmpq *%r11\n\t");
}

/* Identifies a walk's raise to the landing pads it runs: they pass it to
 * scr_unwind_resume. The thrown value is in the active cell. */
static const char scr_unwind_token;

#ifdef SCR_UNWIND_TESTING
/* The walk's raises and resumes that went on with libgcc's unwinder, and
 * the frames whose stack pointer or callee-saved registers differ from
 * libgcc's for the same return address. */
size_t scr_unwind_test_fallbacks;
size_t scr_unwind_test_mismatches;

typedef struct {
  uint64_t ip, cfa, regs[6];
} ScrUnwindTestFrame;

typedef struct {
  ScrUnwindTestFrame frames[512];
  int count, next;
} ScrUnwindTestTrace;

static _Thread_local ScrUnwindTestTrace scr_unwind_test_trace;

static _Unwind_Reason_Code scr_unwind_test_record(struct _Unwind_Context *context, void *arg) {
  ScrUnwindTestTrace *trace = arg;
  if (trace->count == 512) return _URC_END_OF_STACK;
  ScrUnwindTestFrame *frame = &trace->frames[trace->count++];
  frame->ip = _Unwind_GetIP(context);
  frame->cfa = _Unwind_GetCFA(context);
  for (int i = 0; i < 6; i++) frame->regs[i] = _Unwind_GetGR(context, scr_unwind_callee[i]);
  return _URC_NO_REASON;
}

/* Records libgcc's frames from here, before the walk changes anything. */
static void scr_unwind_test_start(void) {
  scr_unwind_test_trace.count = 0;
  scr_unwind_test_trace.next = 0;
  _Unwind_Backtrace(scr_unwind_test_record, &scr_unwind_test_trace);
}

/* Compares the walk's frame, regs at its call, with libgcc's: libgcc's
 * CFA there is the callee's, the frame's stack pointer at the call. */
static void scr_unwind_test_check(const uint64_t *regs) {
  ScrUnwindTestTrace *trace = &scr_unwind_test_trace;
  while (trace->next < trace->count && trace->frames[trace->next].ip != regs[SCR_UNW_RA])
    trace->next++;
  if (trace->next == trace->count) {
    if (trace->count < 512) __atomic_add_fetch(&scr_unwind_test_mismatches, 1, __ATOMIC_RELAXED);
    return;
  }
  const ScrUnwindTestFrame *frame = &trace->frames[trace->next++];
  int same = frame->cfa == regs[SCR_UNW_RSP];
  for (int i = 0; i < 6; i++) same &= frame->regs[i] == regs[scr_unwind_callee[i]];
  if (!same) __atomic_add_fetch(&scr_unwind_test_mismatches, 1, __ATOMIC_RELAXED);
}

#define SCR_UNWIND_FALLBACK() __atomic_add_fetch(&scr_unwind_test_fallbacks, 1, __ATOMIC_RELAXED)
#define SCR_UNWIND_TEST_START() scr_unwind_test_start()
#define SCR_UNWIND_TEST_CHECK(regs) scr_unwind_test_check(regs)
#else
#define SCR_UNWIND_FALLBACK() ((void)0)
#define SCR_UNWIND_TEST_START() ((void)0)
#define SCR_UNWIND_TEST_CHECK(regs) ((void)0)
#endif

/* Walks from the frame regs describes, a caller's registers at its call,
 * and installs the first frame with a landing pad. Returns when a frame is
 * left to libgcc, before anything has been installed. */
static __attribute__((no_sanitize("address"))) void scr_unwind_walk(uint64_t *regs) {
  SCR_UNWIND_TEST_START();
  for (;;) {
    const ScrUnwindPlan *plan = scr_unwind_plan(regs[SCR_UNW_RA]);
    if (plan->fallback) return;
    SCR_UNWIND_TEST_CHECK(regs);
    if (plan->pad != 0) {
#ifdef SCR_UNWIND_ASAN
      /* The frames below the landing pad's never return: clear their
       * redzones' shadow, up to the pad frame's stack pointer. */
      uintptr_t sp;
      __asm__ volatile("movq %%rsp, %0" : "=r"(sp));
      if (regs[SCR_UNW_RSP] > sp)
        __asan_unpoison_memory_region((void *)sp, regs[SCR_UNW_RSP] - sp);
#endif
      scr_unwind_install(regs, plan->pad, &scr_unwind_token);
    }
    uint64_t cfa = regs[plan->cfa_reg] + (uint64_t)(int64_t)plan->cfa_off;
    const uint64_t *frame = (const uint64_t *)(uintptr_t)cfa;
    for (unsigned m = plan->saved; m != 0; m &= m - 1) {
      int i = __builtin_ctz(m);
      regs[scr_unwind_callee[i]] = frame[plan->off[i]];
    }
    regs[SCR_UNW_RA] = frame[-1];
    regs[SCR_UNW_RSP] = cfa;
  }
}

/* Called by the entry stubs below with their caller's registers. */
__attribute__((visibility("hidden"), used)) void scr_unwind_walk_raise(uint64_t *regs) {
  scr_unwind_walk(regs);
}

__attribute__((visibility("hidden"), used)) void scr_unwind_walk_resume(uint64_t *regs,
                                                                        const void *exc) {
  if (exc == &scr_unwind_token) scr_unwind_walk(regs);
}

/* Where the entry stubs go when the walk returns, with the stack as it was
 * at their entry: the caller is the emitted frame. */
__attribute__((visibility("hidden"), used, no_sanitize("address"))) void
scr_unwind_raise_slow(void) {
  SCR_UNWIND_FALLBACK();
  scr_unwind_forced();
}

__attribute__((visibility("hidden"), used, no_sanitize("address"))) void
scr_unwind_resume_slow(void *exc) {
  /* A landing pad that libgcc's unwind ran passes libgcc's exception. */
  if (exc != &scr_unwind_token && _Unwind_Resume != NULL) _Unwind_Resume(exc);
  SCR_UNWIND_FALLBACK();
  scr_unwind_forced();
}

/* The entry stubs store the caller's callee-saved registers, stack pointer
 * after the return and return address into a register array on the stack,
 * indexed by DWARF number (17 slots: 136 bytes, which keeps the stack
 * 16-byte aligned at the call). */
#define SCR_UNWIND_CAPTURE                                                                         \
  "subq $136, %rsp\n\t"                                                                            \
  ".cfi_adjust_cfa_offset 136\n\t"                                                                \
  "movq %rbx, 24(%rsp)\n\t"                                                                        \
  "movq %rbp, 48(%rsp)\n\t"                                                                        \
  "movq %r12, 96(%rsp)\n\t"                                                                        \
  "movq %r13, 104(%rsp)\n\t"                                                                       \
  "movq %r14, 112(%rsp)\n\t"                                                                       \
  "movq %r15, 120(%rsp)\n\t"                                                                       \
  "movq 136(%rsp), %rax\n\t"                                                                       \
  "movq %rax, 128(%rsp)\n\t"                                                                       \
  "leaq 144(%rsp), %rax\n\t"                                                                       \
  "movq %rax, 56(%rsp)\n\t"

__attribute__((naked)) void scr_unwind_raise(void) {
  __asm__ volatile(SCR_UNWIND_CAPTURE "movq %rsp, %rdi\n\t"
                                      "call scr_unwind_walk_raise\n\t"
                                      "addq $136, %rsp\n\t"
                                      ".cfi_adjust_cfa_offset -136\n\t"
                                      "jmp scr_unwind_raise_slow\n\t");
}

/* Landing pads continue the unwind here with the exception they took. */
__attribute__((naked)) void scr_unwind_resume(void *exc) {
  __asm__ volatile(SCR_UNWIND_CAPTURE "movq %rdi, 40(%rsp)\n\t"
                                      "movq %rdi, %rsi\n\t"
                                      "movq %rsp, %rdi\n\t"
                                      "call scr_unwind_walk_resume\n\t"
                                      "movq 40(%rsp), %rdi\n\t"
                                      "addq $136, %rsp\n\t"
                                      ".cfi_adjust_cfa_offset -136\n\t"
                                      "jmp scr_unwind_resume_slow\n\t");
}

#else

void scr_unwind_raise(void) {
  scr_unwind_forced();
  __builtin_unreachable();
}

/* Landing pads continue the unwind here with the exception they took. */
void scr_unwind_resume(void *exc) {
  if (_Unwind_Resume != NULL) _Unwind_Resume(exc);
  scr_unwind_forced();
}

#endif
#endif
