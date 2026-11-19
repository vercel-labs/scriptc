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

/* The dgram unit's block-list checks call into scr_net.c's matcher; this
 * white-box binary links neither the net unit nor its dependencies, and the
 * cases below install no block list, so the two entry points are stubs. */
/* The dgram unit's block-list checks call scr_net.c's matcher; this
 * white-box binary links neither the net unit nor its dependencies, and the
 * cases here install no block list. */
bool scr_net_is_block_list(const ScrDyn *value) {
  (void)value;
  return false;
}

bool scr_net_block_list_blocks(const ScrDyn *list, const char *ip, int family) {
  (void)list;
  (void)ip;
  (void)family;
  return false;
}

static int scr_dgram_test_drain(ScrPoller *p, ScrPollerEvent *out, int max) {
  (void)p;
  int n = scr_dgram_test_batch_len < max ? scr_dgram_test_batch_len : max;
  memcpy(out, scr_dgram_test_batch, (size_t)n * sizeof *out);
  scr_dgram_test_batch_len = 0;
  return n;
}

/* bind({ fd }): the adopted descriptor's socket is bound with the poller up
 * (its read watch is armed against it) and Node's once('listening') callback
 * runs; a non-datagram descriptor is refused instead. */
static int scr_dgram_test_listened;
static void scr_dgram_test_on_listening(ScrClosure *cb) {
  (void)cb;
  scr_dgram_test_listened = 1;
}
/* The resolver's hooks, stubbed: an in-flight query reports pending without
 * any deliverable work. */
static bool scr_dgram_test_dnsq_in_flight;
static bool scr_dgram_test_dnsq_pending(void) { return scr_dgram_test_dnsq_in_flight; }
static bool scr_dgram_test_dnsq_owns(void *udata) {
  (void)udata;
  return false;
}
static void scr_dgram_test_dnsq_event(void *udata, unsigned events) {
  (void)udata;
  (void)events;
}
static void scr_dgram_test_dnsq_cleanup(void) {}

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


  /* bind({ fd }): an adopted datagram descriptor leaves the socket bound,
   * with the poller up (the read watch arms against it) and the callback
   * run as Node's once('listening'). */
  {
    int udp = (int)socket(AF_INET, SOCK_DGRAM, 0);
    assert(udp >= 0);
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof addr);
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = 0;
    assert(bind(udp, (struct sockaddr *)&addr, sizeof addr) == 0);

    ScrDgramSocket *adopted = scr_dgram_create(false, false, false, false, 0, 0);
    assert(adopted != NULL);
    /* A message listener makes the read watch wanted, as Node's binding one
     * does; its firing is not part of this white-box case. */
    scr_dgram_ls_add(&adopted->msg_ls,
                     scr_closure_new((void *)&scr_dgram_test_on_listening, 0),
                     (void *)&scr_dgram_test_on_listening, false);
    ScrDyn *opts = scr_dyn_new_obj();
    scr_dyn_obj_set(opts, "fd", 2, scr_dyn_new_num((double)udp));
    scr_dgram_bind_opts(adopted,
                        opts, scr_closure_new((void *)&scr_dgram_test_on_listening, 0));
    scr_dyn_release(opts);
    assert(!scr_exc_pending());
    assert(adopted->bound);
    assert(adopted->fd == udp);
    assert(scr_dgram_poller != NULL);
    assert(adopted->read_armed);
    scr_dgram_sweep();
    assert(scr_dgram_test_listened == 1);
    scr_dgram_close(adopted, NULL);
    scr_dgram_sweep();
    scr_dgram_release(adopted);
  }

#ifndef _WIN32
  /* A descriptor that is not a datagram socket is refused with Node's
   * name for its kind. */
  {
    int file = open("/dev/null", O_RDONLY);
    assert(file >= 0);
    ScrDgramSocket *refused = scr_dgram_create(false, false, false, false, 0, 0);
    ScrDyn *opts = scr_dyn_new_obj();
    scr_dyn_obj_set(opts, "fd", 2, scr_dyn_new_num((double)file));
    scr_dgram_bind_opts(refused, opts, NULL);
    scr_dyn_release(opts);
    assert(scr_exc_pending());
    scr_exc_clear();
    assert(!refused->bound);
    close(file);
    scr_dgram_release(refused);
  }
#endif
  /* The wake predicate covers deliverable work only: a query still in
   * flight waits on the poller's own keys and must not arm the wake timer,
   * while a deferred emit must. */
  {
    static const ScrDnsqHooks hooks = {scr_dgram_test_dnsq_pending, scr_dgram_test_dnsq_owns,
                                       scr_dgram_test_dnsq_event, scr_dgram_test_dnsq_cleanup};
    scr_dgram_test_dnsq_in_flight = true;
    scr_dnsq_hooks = &hooks;
    assert(!scr_dgram_wake_due());
    ScrDgramSocket *quiet = scr_dgram_create(false, false, false, false, 0, 0);
    quiet->emit_connect = true;
    scr_dgram_register(quiet);
    assert(scr_dgram_wake_due());
    scr_dgram_unregister(quiet);
    scr_dgram_release(quiet);
    scr_dnsq_hooks = NULL;
    scr_dgram_test_dnsq_in_flight = false;
    printf("the wake predicate covers deliverable work only\n");
  }

  scr_dgram_unregister(live); /* the registry reference was the last one */
  printf("a key no socket owns is not read as a socket\n");
  printf("bind({ fd }) adopts the descriptor with the poller up\n");
  return 0;
}
