/* White-box poller dispatch: a copied batch can name a key that owns
 * nothing any more. The dns queries free their keys from inside a drain
 * (scr_dnsq_finish), and the drain order is not a guard by itself — epoll
 * appends expired timers after the socket events, but kqueue copies the
 * kernel's order, where a timeout that exhausts a query can arrive before
 * that query's readiness. The dispatch must therefore read only keys the
 * socket registry holds, in either order.
 *
 * The batch below is handed to the dispatch directly. Its first event names
 * an unmapped page — the memory a freed key leaves behind — so reading a
 * socket field from it faults; the second names a registered socket that is
 * closed (fd -1), which the fd check drops. Reading live sockets is what the
 * dgram and dns corpus programs exercise. */
#undef NDEBUG
#include <assert.h>
#include <stdio.h>
#include <string.h>

#if defined(_WIN32)
#include <windows.h>
#else
#include <sys/mman.h>
#include <unistd.h>
#endif

#include "scr_platform.h"

/* The dispatch's drain: the test owns the whole batch. */
static ScrPollerEvent scr_dgram_test_batch[2];
static int scr_dgram_test_batch_len;
static int scr_dgram_test_drain(ScrPoller *p, ScrPollerEvent *out, int max);

#define scrp_drain scr_dgram_test_drain
#include "scr_dgram.c"

static int scr_dgram_test_drain(ScrPoller *p, ScrPollerEvent *out, int max) {
  (void)p;
  int n = scr_dgram_test_batch_len < max ? scr_dgram_test_batch_len : max;
  memcpy(out, scr_dgram_test_batch, (size_t)n * sizeof *out);
  scr_dgram_test_batch_len = 0;
  return n;
}

/* One page that faults on any read: what a freed poll key leaves behind. */
static void *faulting_page(void) {
#if defined(_WIN32)
  void *page = VirtualAlloc(NULL, 4096, MEM_RESERVE | MEM_COMMIT, PAGE_NOACCESS);
  assert(page != NULL);
  return page;
#else
  long size = sysconf(_SC_PAGESIZE);
  assert(size > 0);
  void *page = mmap(NULL, (size_t)size, PROT_NONE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  assert(page != MAP_FAILED);
  return page;
#endif
}

int main(void) {
  /* A registered socket keeps the dispatch past its "nothing registered"
   * exit and is the second event's key. */
  ScrDgramSocket *live = calloc(1, sizeof *live);
  assert(live != NULL);
  live->fd = -1;
  scr_dgram_register(live);
  assert(scr_dgram_poller_init());

  scr_dgram_test_batch[0].udata = faulting_page();
  scr_dgram_test_batch[0].events = SCRP_READABLE;
  scr_dgram_test_batch[1].udata = live;
  scr_dgram_test_batch[1].events = SCRP_READABLE;
  scr_dgram_test_batch_len = 2;
  scr_dgram_dispatch();

  scr_dgram_unregister(live); /* the registry reference was the last one */
  printf("a key no socket owns is not read as a socket\n");
  return 0;
}
