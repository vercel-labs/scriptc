/* child_process — the spawnSync capture Buffers (SpawnSyncReturns<Buffer>).
 *
 * A separate runtime unit, selected only by programs that read an unencoded
 * capture (spawnRes.stdoutBytes / spawnRes.stderrBytes), so an executable
 * that never reads one keeps byte-identical code from scr_child.c: adding
 * these functions and their thread-local state there changes that unit's
 * `.eh_frame` contribution and TLS block, which the linker carries into
 * every program that links it.
 *
 * A stored spawnSync capture as the typed Buffer result.stdout/result.stderr
 * read answers when no { encoding } option was given: the captured bytes.
 * Node's capture is a Buffer, so the brand is set as scr_child_sync_output's
 * dynamic Buffers set it; a program can only observe it through the
 * Buffer-brand reads the fsBufferBrand scan finds.
 *
 * Node builds ONE Buffer per capture while building the result, so every
 * read of `result.stdout` answers that same object: `result.stdout ===
 * result.stdout` holds, and a write through one read is visible through the
 * next. The first read materializes the Buffer, and the memo below answers
 * it again for every later read of the same capture. An entry holds the
 * capture string (+1) — the key, so its address is never reused by a later
 * allocation — and the Buffer (+1) the reads are handed. A stream the call
 * did not pipe has no capture (Node's null; this surface's empty Buffer)
 * and answers one shared empty Buffer, so `===` between two reads holds
 * there too.
 *
 * Lifetime: an entry is the memo's own reference, never the program's, so
 * it is dropped as soon as the capture has no other owner (rc == 1: the
 * result was released, and nothing can read that capture again) by the
 * sweep below, and the rest go at the thread's exit — the memo registers
 * that teardown on its first read, so it runs before the runtime's exit
 * audit, like every other lazy teardown. The memo is thread-local like the
 * child registry. */
#include "scr_runtime.h"
#include <stdlib.h>

typedef struct {
  ScrStr *capture; /* +1, the memo's key */
  ScrBytes *bytes; /* +1, what a read of that capture answers */
} ScrSpawnCaptureBuffer;
static SCR_TL ScrSpawnCaptureBuffer *scr_spawn_capture_buffers;
static SCR_TL size_t scr_spawn_capture_buffer_n;
static SCR_TL size_t scr_spawn_capture_buffer_cap;
static SCR_TL ScrBytes *scr_spawn_capture_null_buffer;
static SCR_TL bool scr_spawn_capture_buffers_watched;

/* A fresh branded copy of a capture's bytes (+1). */
static ScrBytes *scr_spawn_capture_bytes_new(ScrStr *capture) {
  ScrBytes *bytes = scr_bytes_from_data(
      capture ? (const uint8_t *)capture->data : NULL, capture ? capture->len : 0);
  if (bytes) bytes->is_buffer = true;
  return bytes;
}

static void scr_spawn_capture_buffers_teardown(void) {
  for (size_t i = 0; i < scr_spawn_capture_buffer_n; i++) {
    scr_str_release(scr_spawn_capture_buffers[i].capture);
    scr_bytes_release(scr_spawn_capture_buffers[i].bytes);
  }
  free(scr_spawn_capture_buffers);
  scr_spawn_capture_buffers = NULL;
  scr_spawn_capture_buffer_n = 0;
  scr_spawn_capture_buffer_cap = 0;
  scr_bytes_release(scr_spawn_capture_null_buffer);
  scr_spawn_capture_null_buffer = NULL;
}

/* Drop the entries whose result is gone: the memo is then the capture's
 * only owner (rc == 1) and nothing can read it again. */
static void scr_spawn_capture_buffers_sweep(void) {
  size_t keep = 0;
  for (size_t i = 0; i < scr_spawn_capture_buffer_n; i++) {
    ScrSpawnCaptureBuffer entry = scr_spawn_capture_buffers[i];
    if (entry.capture->rc == 1) {
      scr_str_release(entry.capture);
      scr_bytes_release(entry.bytes);
      continue;
    }
    scr_spawn_capture_buffers[keep++] = entry;
  }
  scr_spawn_capture_buffer_n = keep;
}

ScrBytes *scr_spawn_res_capture_bytes(ScrStr *capture) {
  if (capture == NULL) {
    if (scr_spawn_capture_null_buffer == NULL) {
      scr_spawn_capture_null_buffer = scr_spawn_capture_bytes_new(NULL);
      if (!scr_spawn_capture_buffers_watched) {
        scr_spawn_capture_buffers_watched = true;
        scr_atexit(scr_spawn_capture_buffers_teardown);
      }
    }
    return scr_bytes_retain(scr_spawn_capture_null_buffer);
  }
  for (size_t i = 0; i < scr_spawn_capture_buffer_n; i++)
    if (scr_spawn_capture_buffers[i].capture == capture)
      return scr_bytes_retain(scr_spawn_capture_buffers[i].bytes);
  if (scr_spawn_capture_buffer_n == scr_spawn_capture_buffer_cap &&
      scr_spawn_capture_buffer_n != 0) {
    scr_spawn_capture_buffers_sweep();
    if (scr_spawn_capture_buffer_n == scr_spawn_capture_buffer_cap) {
      size_t cap = scr_spawn_capture_buffer_cap * 2;
      ScrSpawnCaptureBuffer *grown =
          realloc(scr_spawn_capture_buffers, cap * sizeof *grown);
      /* Out of memory: answer a Buffer that is right but not memoized, so
       * the value stays correct and only the identity memo is skipped. */
      if (grown == NULL) return scr_spawn_capture_bytes_new(capture);
      scr_spawn_capture_buffers = grown;
      scr_spawn_capture_buffer_cap = cap;
    }
  }
  if (scr_spawn_capture_buffer_cap == 0) {
    scr_spawn_capture_buffers = malloc(8 * sizeof *scr_spawn_capture_buffers);
    if (scr_spawn_capture_buffers == NULL) return scr_spawn_capture_bytes_new(capture);
    scr_spawn_capture_buffer_cap = 8;
  }
  if (!scr_spawn_capture_buffers_watched) {
    scr_spawn_capture_buffers_watched = true;
    scr_atexit(scr_spawn_capture_buffers_teardown);
  }
  ScrBytes *bytes = scr_spawn_capture_bytes_new(capture);
  scr_spawn_capture_buffers[scr_spawn_capture_buffer_n].capture = scr_str_retain(capture);
  scr_spawn_capture_buffers[scr_spawn_capture_buffer_n].bytes = bytes;
  scr_spawn_capture_buffer_n++;
  return scr_bytes_retain(bytes);
}
