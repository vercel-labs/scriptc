#ifndef SCR_WIN_STATS_H
#define SCR_WIN_STATS_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* IO_REPARSE_TAG_MOUNT_POINT covers both directory junctions and mounted
 * volumes. Node/libuv only presents drive-letter junction targets as links;
 * a volume target (\\??\\Volume{...}) is followed even by lstat(). Keep this
 * predicate platform-neutral so its payload classification can be unit-tested
 * without requiring a spare Windows volume. */
static inline bool scr_win_stats_mount_target_is_junction(
    const uint16_t *target, size_t len) {
  return len >= 6 &&
         target[0] == '\\' && target[1] == '?' && target[2] == '?' &&
         target[3] == '\\' &&
         ((target[4] >= 'A' && target[4] <= 'Z') ||
          (target[4] >= 'a' && target[4] <= 'z')) &&
         target[5] == ':' && (len == 6 || target[6] == '\\');
}

#endif /* SCR_WIN_STATS_H */
