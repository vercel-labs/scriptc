/* scriptc runtime — BigIntStats member reads (scr_lib.c's stat snapshot,
 * read through Node's bigint member table). Linked only into programs whose
 * IR reads a BigIntStats member (the compiler's `bigint` runtime feature), so
 * a program that never asks for `statSync(p, { bigint: true })` members links
 * none of this.
 *
 * Node's BigIntStats answers a bigint for EVERY number member of Stats: the
 * integers, the `*Ms` millisecond members (the truncated nanosecond
 * quotient, as the binding computes them) and the BigIntStats-only `*Ns`
 * nanosecond members (sec * 1e9 + nsec, exactly as scr_lib.c's dynamic
 * conversion does). The four Date members are built from the `*Ms` member,
 * as Node's getters do (new Date(Math.round(Number(this.atimeMs)))): the
 * truncated millisecond, where Stats rounds its fractional one.
 * Every bigint here is answered +1 like the rest of the snapshot accessors. */
#include "scr_bigint.h"
#include "scr_lib.h"
#include "scr_number.h"
#include "scr_stats_private.h"

/* The binding hands its BigInt64Array signed values. */
static ScrBigInt *scr_stats_big_field(const ScrStats *s, size_t index) {
  return scr_bigint_from_i64((int64_t)s->fields[index]);
}

ScrBigInt *scr_stats_big_dev(ScrStats *s) { return scr_stats_big_field(s, SCR_STATS_DEV); }
ScrBigInt *scr_stats_big_mode(ScrStats *s) { return scr_stats_big_field(s, SCR_STATS_MODE); }
ScrBigInt *scr_stats_big_nlink(ScrStats *s) { return scr_stats_big_field(s, SCR_STATS_NLINK); }
ScrBigInt *scr_stats_big_uid(ScrStats *s) { return scr_stats_big_field(s, SCR_STATS_UID); }
ScrBigInt *scr_stats_big_gid(ScrStats *s) { return scr_stats_big_field(s, SCR_STATS_GID); }
ScrBigInt *scr_stats_big_rdev(ScrStats *s) { return scr_stats_big_field(s, SCR_STATS_RDEV); }
ScrBigInt *scr_stats_big_blksize(ScrStats *s) { return scr_stats_big_field(s, SCR_STATS_BLKSIZE); }
ScrBigInt *scr_stats_big_ino(ScrStats *s) { return scr_stats_big_field(s, SCR_STATS_INO); }
ScrBigInt *scr_stats_big_size(ScrStats *s) { return scr_stats_big_field(s, SCR_STATS_SIZE); }
ScrBigInt *scr_stats_big_blocks(ScrStats *s) { return scr_stats_big_field(s, SCR_STATS_BLOCKS); }

/* nsFromTimeSpecBigInt: sec * 1_000_000_000 + nsec in exact bigint
 * arithmetic (a 64-bit product would overflow far outside the range a
 * filesystem timestamp can hold, but exactness is free here). */
static ScrBigInt *scr_stats_big_ns_of(const ScrStats *s, int which) {
  ScrBigInt *sec = scr_bigint_from_i64(s->sec[which]);
  ScrBigInt *nsec = scr_bigint_from_i64(s->nsec[which]);
  ScrBigInt *billion = scr_bigint_from_i64(1000000000);
  ScrBigInt *scaled = scr_bigint_mul(sec, billion);
  ScrBigInt *total = scr_bigint_add(scaled, nsec);
  scr_bigint_release(sec);
  scr_bigint_release(nsec);
  scr_bigint_release(billion);
  scr_bigint_release(scaled);
  return total;
}

/* The millisecond member: the nanosecond count divided by 1e6 (bigint
 * division truncates toward zero). */
static ScrBigInt *scr_stats_big_ms_of(const ScrStats *s, int which) {
  ScrBigInt *total = scr_stats_big_ns_of(s, which);
  ScrBigInt *million = scr_bigint_from_i64(1000000);
  ScrBigInt *ms = scr_bigint_div(total, million);
  scr_bigint_release(total);
  scr_bigint_release(million);
  return ms;
}

ScrBigInt *scr_stats_big_atime_ns(ScrStats *s) {
  return scr_stats_big_ns_of(s, SCR_STATS_ATIME);
}
ScrBigInt *scr_stats_big_mtime_ns(ScrStats *s) {
  return scr_stats_big_ns_of(s, SCR_STATS_MTIME);
}
ScrBigInt *scr_stats_big_ctime_ns(ScrStats *s) {
  return scr_stats_big_ns_of(s, SCR_STATS_CTIME);
}
ScrBigInt *scr_stats_big_birthtime_ns(ScrStats *s) {
  return scr_stats_big_ns_of(s, SCR_STATS_BIRTHTIME);
}

ScrBigInt *scr_stats_big_atime_ms(ScrStats *s) {
  return scr_stats_big_ms_of(s, SCR_STATS_ATIME);
}
ScrBigInt *scr_stats_big_mtime_ms(ScrStats *s) {
  return scr_stats_big_ms_of(s, SCR_STATS_MTIME);
}
ScrBigInt *scr_stats_big_ctime_ms(ScrStats *s) {
  return scr_stats_big_ms_of(s, SCR_STATS_CTIME);
}
ScrBigInt *scr_stats_big_birthtime_ms(ScrStats *s) {
  return scr_stats_big_ms_of(s, SCR_STATS_BIRTHTIME);
}

static double scr_stats_big_date_of(const ScrStats *s, int which) {
  ScrBigInt *ms = scr_stats_big_ms_of(s, which);
  double date = scr_date_new_ms(scr_bigint_to_f64(ms));
  scr_bigint_release(ms);
  return date;
}

double scr_stats_big_atime(ScrStats *s) { return scr_stats_big_date_of(s, SCR_STATS_ATIME); }
double scr_stats_big_mtime(ScrStats *s) { return scr_stats_big_date_of(s, SCR_STATS_MTIME); }
double scr_stats_big_ctime(ScrStats *s) { return scr_stats_big_date_of(s, SCR_STATS_CTIME); }
double scr_stats_big_birthtime(ScrStats *s) { return scr_stats_big_date_of(s, SCR_STATS_BIRTHTIME); }
