/* scriptc runtime — the dgram socket's layout, shared by scr_dgram.c and
 * the checked-dynamic unit scr_dgram_dyn.c (runtime-internal; not part of
 * scr_runtime.h). */
#ifndef SCR_DGRAM_PRIVATE_H
#define SCR_DGRAM_PRIVATE_H

#include "scr_runtime.h"

/* ── listener lists (the scr_net.c snapshot discipline, restated so this
 * unit links without scr_net.c) ─────────────────────────────────────── */

typedef struct {
  ScrClosure *cb;
  void *fn;
  bool once;
} ScrDgramL;

typedef struct {
  ScrDgramL *ls;
  size_t n, cap;
} ScrDgramLs;

/* ── the handle ──────────────────────────────────────────────────────── */

struct ScrDgramSocket {
  size_t rc;
  int fd; /* -1 until bound/connected, -1 again once closed */
  bool reuse_addr;
  bool bound;
  bool connected;
  bool closing;       /* close() called; 'close' fires at the next sweep */
  bool close_emitted; /* settled: off the registry, listeners dropped */
  bool unrefed;       /* waives loop liveness, Node's unref */
  bool read_armed;
  bool emit_listening;
  bool emit_connect;
  ScrStr *pending_err; /* deferred bind/connect/send failure */
  ScrDgramLs msg_ls, err_ls, listening_ls, close_ls, conn_ls;
  bool in_registry;
  struct ScrDgramSocket *next;
};

/* Re-evaluates the socket's read arming after its 'message' listeners
 * changed (scr_dgram.c). */
void scr_dgram_rearm(ScrDgramSocket *s);

#endif /* SCR_DGRAM_PRIVATE_H */
