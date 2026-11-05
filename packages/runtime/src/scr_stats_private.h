/* scriptc runtime — the stat snapshot's layout (scr_lib.c). PRIVATE: the
 * enums index fields[] and the two time arrays exactly as scr_lib.c fills
 * them. Only scr_lib.c itself and the BigIntStats member reads
 * (scr_stats_bigint.c) may include this; everything else reads the snapshot
 * through scr_lib.h's accessors. Keeping the layout in one header is what
 * lets the bigint members live in their own unit, so a program that never
 * reads them links none of that code. */
#ifndef SCR_STATS_PRIVATE_H
#define SCR_STATS_PRIVATE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* The integers in the order Node's binding reports them. */
enum {
  SCR_STATS_DEV,
  SCR_STATS_MODE,
  SCR_STATS_NLINK,
  SCR_STATS_UID,
  SCR_STATS_GID,
  SCR_STATS_RDEV,
  SCR_STATS_BLKSIZE,
  SCR_STATS_INO,
  SCR_STATS_SIZE,
  SCR_STATS_BLOCKS,
  SCR_STATS_FIELDS
};

/* The timestamps, each kept as seconds + nanoseconds. */
enum { SCR_STATS_ATIME, SCR_STATS_MTIME, SCR_STATS_CTIME, SCR_STATS_BIRTHTIME };

struct ScrStats {
  size_t rc;
  bool is_file;
  bool is_dir;
  bool is_symlink; /* lstat only — a followed stat never sees one */
  uint64_t fields[SCR_STATS_FIELDS]; /* blocks counts 512-byte units */
  int64_t sec[4];
  int64_t nsec[4];
};

#endif /* SCR_STATS_PRIVATE_H */
