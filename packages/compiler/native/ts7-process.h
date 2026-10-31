#ifndef SCRIPTC_TS7_PROCESS_H
#define SCRIPTC_TS7_PROCESS_H

#include <stddef.h>
#include <stdint.h>

/* A compiler host boundary, called synchronously on the compiler thread.
 * Handles are monotonically assigned IDs, never pointer-shaped numbers.
 * Zero is an invalid handle. Failed transfers return -1; EOF returns 0.
 * The last error is copied before another host operation can overwrite it.
 * All spans are borrowed for the duration of the call only. */
uint32_t scriptc_ts7_open(const uint8_t *executable, size_t executable_size,
                         const uint8_t *cwd, size_t cwd_size,
                         const uint8_t *callbacks, size_t callbacks_size,
                         uint8_t timing, uint8_t libraries_from_disk);
/* Connects to the shared checker server `name` (`--api --listen`) in this
 * user's private server directory, starting it in its own process group
 * with `--idle-exit idle_exit` and a limit of `memory` megabytes
 * (TSC_TS_LISTEN_MEMORY, unless the environment sets it) when none answers. Returns 0 with the error
 * text when another build is connected to it, it cannot be started or
 * reached, or the platform has no Unix sockets; the caller then starts its
 * own server with scriptc_ts7_open. Closing the handle ends the connection
 * and leaves the server running. */
uint32_t scriptc_ts7_attach(const uint8_t *name, size_t name_size,
                           const uint8_t *executable, size_t executable_size,
                           const uint8_t *cwd, size_t cwd_size,
                           const uint8_t *callbacks, size_t callbacks_size,
                           uint8_t timing, uint8_t libraries_from_disk, uint32_t idle_exit,
                           uint32_t memory);
int32_t scriptc_ts7_read(uint32_t handle, uint8_t *bytes, size_t size,
                        uint32_t offset, uint32_t length);
int32_t scriptc_ts7_write(uint32_t handle, const uint8_t *bytes, size_t size,
                         uint32_t offset, uint32_t length);
uint32_t scriptc_ts7_pid(uint32_t handle);
void scriptc_ts7_close(uint32_t handle);
void scriptc_ts7_close_all(void);
int32_t scriptc_ts7_error(uint8_t *bytes, size_t size);
/* The index after the JSON value that starts at `start` in a checker reply,
 * as jsonValueEnd in semantic-json.ts computes it, or -1 when the reply is
 * malformed there. */
int32_t scriptc_ts7_json_value_end(const uint8_t *bytes, size_t size, uint32_t start);

#endif
