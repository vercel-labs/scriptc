/* scriptc runtime — node:dgram and node:dns (scr_dgram.c). Included by
 * scr_runtime.h, which says where new declarations go. */
#ifndef SCR_DGRAM_H
#define SCR_DGRAM_H

#include "scr_http2.h"

/* ── node:dgram + node:dns (scr_dgram.c — compiled only when the program
 * uses either; design note atop the file). One lean refcounted handle
 * kind (the netSocket ownership story: listeners MOVE in and drop at
 * settlement); dns.lookup rides the same unit — getaddrinfo runs AT CALL
 * TIME and the callback defers to the next loop turn. Self-contained: no
 * symbol here requires scr_net.c to link. */
typedef struct ScrDgramSocket ScrDgramSocket;
/* The message adapter: msg and the rinfo parts arrive BORROWED (multiple
 * listeners see the same datagram); adapters retain what they keep. */
typedef void (*ScrDgramMsgFn)(ScrClosure *cb, ScrBytes *msg, ScrStr *addr, ScrStr *family, double port, double size);
/* The dns.lookup adapter: errmsg is NULL on success; everything borrowed. */
typedef void (*ScrDnsLookupFn)(ScrClosure *cb, ScrStr *errmsg, ScrStr *addr, double family);

ScrDgramSocket *scr_dgram_retain(ScrDgramSocket *s);
void scr_dgram_release(ScrDgramSocket *s);
void *scr_dgram_retain_v(void *p);
void scr_dgram_release_v(void *p);

ScrDgramSocket *scr_dgram_create(bool reuse_addr); /* +1 */
/* bind/connect: host borrowed; "" binds 0.0.0.0 (bind's Node default).
 * The callback (nullable, moves) registers as once('listening') /
 * once('connect'). Both THROW Node's state errors on a bound/connected/
 * closed socket; runtime failures (EADDRINUSE) are the async 'error'. */
void scr_dgram_bind(ScrDgramSocket *s, double port, ScrStr *host /*borrowed*/, ScrClosure *cb /*moves, nullable*/);
void scr_dgram_connect(ScrDgramSocket *s, double port, ScrStr *host /*borrowed*/, ScrClosure *cb /*moves, nullable*/);
void scr_dgram_send_str(ScrDgramSocket *s, ScrStr *data /*borrowed*/, double port, ScrStr *host /*borrowed*/);
void scr_dgram_send_bytes(ScrDgramSocket *s, ScrBytes *data /*borrowed*/, double port, ScrStr *host /*borrowed*/);
/* The send argument-validation ladder over dyn arguments (Node's
 * signature shuffle, slice bounds, list/type contracts, port/address
 * validation, and the connected-state errors), then the send: a list
 * goes out as one datagram, a connected socket sends to its peer, and a
 * completion callback receives (null, bytes) or the failure after this
 * turn. */
void scr_dgram_send_chk(ScrDgramSocket *s, const ScrDyn *buffer, const ScrDyn *a1,
                        const ScrDyn *a2, const ScrDyn *a3, const ScrDyn *a4,
                        const ScrDyn *a5);
/* The socket as an untyped value (SCR_DYNH_DGRAM_SOCKET): boxes of one
 * socket share its untyped listeners; the first box installs the tag's
 * ops. Borrows s; +1. The unbox checks the tag and answers the socket
 * (+1), or NULL with the path-annotated TypeError pending. */
ScrDyn *scr_dgram_to_dyn(ScrDgramSocket *s);
ScrDgramSocket *scr_dgram_from_dyn(const ScrDyn *d, const ScrDynPath *path, const char *want);
/* address() parts: ip THROWS "Not running" before bind/connect (+1
 * otherwise); family/port are only called after ip succeeded. */
ScrStr *scr_dgram_addr_ip(ScrDgramSocket *s);     /* +1, may throw */
ScrStr *scr_dgram_addr_family(ScrDgramSocket *s); /* +1 */
double scr_dgram_addr_port(ScrDgramSocket *s);
void scr_dgram_close(ScrDgramSocket *s, ScrClosure *cb /*moves, nullable*/); /* throws on closed */
void scr_dgram_unref(ScrDgramSocket *s);
void scr_dgram_ref(ScrDgramSocket *s);
/* Unix datagram sockets for the hot-shots package shim (the unix-dgram
 * addon's surface): each answers its result (fd, 0) or a negative errno;
 * send answers 1 when the socket would block. */
double scr_dgram_unix_socket(void);
double scr_dgram_unix_connect(double fd, ScrStr *path /*borrowed*/);
double scr_dgram_unix_send(double fd, ScrBytes *data /*borrowed*/);
double scr_dgram_unix_close(double fd);
/* Socket options: Node's checks and errors (ErrnoException "<syscall>
 * <CODE>", ERR_SOCKET_BAD_BUFFER_SIZE, ERR_SOCKET_BUFFER_SIZE, the
 * TypeError after close()). The TTL setters and setMulticastLoopback
 * answer their argument; group and iface are borrowed. */
void scr_dgram_set_broadcast(ScrDgramSocket *s, bool flag);
double scr_dgram_set_ttl(ScrDgramSocket *s, double ttl);
double scr_dgram_set_multicast_ttl(ScrDgramSocket *s, double ttl);
bool scr_dgram_set_multicast_loopback(ScrDgramSocket *s, bool flag);
void scr_dgram_set_multicast_interface(ScrDgramSocket *s, ScrStr *iface);
void scr_dgram_add_membership(ScrDgramSocket *s, ScrStr *group, ScrStr *iface, bool has_iface);
void scr_dgram_drop_membership(ScrDgramSocket *s, ScrStr *group, ScrStr *iface, bool has_iface);
double scr_dgram_get_recv_buffer_size(ScrDgramSocket *s);
double scr_dgram_get_send_buffer_size(ScrDgramSocket *s);
void scr_dgram_set_recv_buffer_size(ScrDgramSocket *s, double size);
void scr_dgram_set_send_buffer_size(ScrDgramSocket *s, double size);
double scr_dgram_get_send_queue_size(ScrDgramSocket *s);
double scr_dgram_get_send_queue_count(ScrDgramSocket *s);
void scr_dgram_disconnect(ScrDgramSocket *s);
void scr_dgram_on_message(ScrDgramSocket *s, ScrClosure *cb /*moves*/, ScrDgramMsgFn fn, bool once);
void scr_dgram_on_error(ScrDgramSocket *s, ScrClosure *cb /*moves*/, ScrChildErrFn fn, bool once);
void scr_dgram_on_listening(ScrDgramSocket *s, ScrClosure *cb /*moves*/, bool once);
void scr_dgram_on_close(ScrDgramSocket *s, ScrClosure *cb /*moves*/, bool once);
void scr_dgram_on_connect(ScrDgramSocket *s, ScrClosure *cb /*moves*/, bool once);
/* The runtime-provided message adapters (zero/one-param listeners; the
 * two-param rinfo shape is emitted per record shape). */
void scr_dgram_msg_thunk0(ScrClosure *cb, ScrBytes *msg, ScrStr *addr, ScrStr *family, double port, double size);
void scr_dgram_msg_thunk1(ScrClosure *cb, ScrBytes *msg, ScrStr *addr, ScrStr *family, double port, double size);
/* dns.lookup: hostname borrowed, family is 4 (AF_INET pinned by the
 * frontend), the callback moves. getaddrinfo runs NOW (blocking —
 * SEMANTICS.md); delivery defers to the next loop turn. */
void scr_dns_lookup(ScrStr *hostname /*borrowed*/, double family, ScrClosure *cb /*moves*/, ScrDnsLookupFn fn);
/* Node's dns argument forms, with dyn callbacks (all borrowed). */
void scr_dns_lookup_dyn(const ScrDyn *hostname, const ScrDyn *options, const ScrDyn *callback,
                        bool typed);
void scr_dns_lookup_service(const ScrDyn *address, const ScrDyn *port, const ScrDyn *callback,
                            bool typed);
/* util.promisify(dns.lookup) and util.promisify(dns.lookupService): a +1
 * promise of the checked-dynamic result; never throws. */
typedef struct ScrPromise ScrPromise;
ScrPromise *scr_dns_lookup_promise(const ScrDyn *hostname, const ScrDyn *options);
ScrPromise *scr_dns_lookup_service_promise(const ScrDyn *address, const ScrDyn *port);
/* node:dns/promises (scr_dns_promises.c, linked only for the module's
 * promise forms): lib/internal/dns/promises.js's stricter argument checks
 * throw synchronously; the promise (+1), or NULL with the argument error
 * pending. Arguments borrowed. */
ScrPromise *scr_dns_promises_lookup(const ScrDyn *hostname, const ScrDyn *options);
ScrPromise *scr_dns_promises_lookup_service(const ScrDyn *address, const ScrDyn *port);
ScrDyn *scr_dns_get_servers(void);                  /* +1 */
/* ── the stub resolver (scr_dns_resolve.c, the same dgram unit) ────────
 * dns.resolve4 etc., dns.reverse, dns.setServers and dns.Resolver:
 * lib/internal/dns/{utils,callback_resolver,promises}.js's argument
 * checks over the callback forms (binding names the c-ares query the
 * error's syscall and message carry: "queryA", "getHostByAddr", ...), a
 * UDP query to the resolver's servers with TCP fallback, and the
 * promise forms. The default resolver is the one dns.setServers
 * replaces; a new Resolver starts from the system's servers. */
void scr_dns_resolve_chk(const ScrStr *binding, const ScrDyn *name, const ScrDyn *options,
                         const ScrDyn *callback, bool typed);
ScrPromise *scr_dns_resolve_promise(const ScrStr *binding, const ScrDyn *name,
                                    const ScrDyn *options); /* +1 */
/* resolve(hostname, rrtype[, callback]) and its promise form: the rrtype
 * picks the binding at run time (Node's resolveMap). */
void scr_dns_resolve_rr_chk(const ScrDyn *name, const ScrDyn *rrtype, const ScrDyn *callback, bool typed);
ScrPromise *scr_dns_resolve_rr_promise(const ScrDyn *name, const ScrDyn *rrtype); /* +1 */
/* new Resolver(options?): the handle (+1), built by dns/promises' class
 * when `promises` (the two classes are distinct instanceof targets). */
ScrDyn *scr_dns_resolver_new(const ScrDyn *options, bool promises); /* +1 */
bool scr_dns_resolver_is(const ScrDyn *v, bool promises);
/* dns.setServers replaces both modules' default servers (Node binds the two
 * modules' functions to one Resolver); dns/promises.setServers replaces only
 * the promise module's. Both may throw, leaving the previous list in place. */
void scr_dns_set_servers(const ScrDyn *servers);
void scr_dns_promises_set_servers(const ScrDyn *servers);
ScrDyn *scr_dns_get_servers_default(bool promises); /* +1 */
/* The resolver's loop share, installed by scr_dns_resolve_install (NULL
 * when that unit is not linked): pending queries hold the loop, the
 * dispatch drain routes their poller events, and exit cleanup releases
 * them. */
typedef struct ScrDnsqHooks {
  bool (*pending)(void);
  bool (*owns)(void *udata);
  void (*event)(void *udata, unsigned events);
  void (*cleanup)(void);
} ScrDnsqHooks;
extern const ScrDnsqHooks *scr_dnsq_hooks;
void scr_dns_resolve_install(void);

/* The dgram-side primitives the resolver's queries ride (scr_dgram.c):
 * the unit poller (created on demand), fd watch/unwatch, the
 * forget-then-close pair, the one-shot timers, and deferred delivery on
 * the dns pending queue. */
void scr_dgram_poll_ready(void);
void scr_dgram_poll_read(int fd, void *udata, bool on);
void scr_dgram_poll_write(int fd, void *udata, bool on);
void scr_dgram_poll_forget(int fd);
void scr_dgram_poll_close(int fd);
bool scr_dgram_poll_timer(void *key, double ms, void *udata);
void scr_dgram_poll_timer_cancel(void *key);
/* Queues a built [callback, ...args] dyn array (+1) for the next sweep. */
void scr_dns_deliver_dyn(ScrDyn *call);
/* dns.getServers()/dnsPromises.getServers() over the module default
 * resolver (+1 array); NULL hook = the system (resolv.conf) reading. */
extern ScrDyn *(*scr_dns_servers_hook)(bool promises);
ScrStr *scr_dns_get_default_result_order(void);     /* +1 */
void scr_dns_set_default_result_order(const ScrDyn *order);
void scr_dns_thunk0(ScrClosure *cb, ScrStr *errmsg, ScrStr *addr, double family);
void scr_dgram_install(void);
#ifdef SCR_RC_AUDIT
long scr_dgram_live_count(void);
#endif
/* The loop-side registration (scr_async.c, always linked) — the net
 * hook's exact shape, one more nullable slot set. */
void scr_loop_set_dgram(bool (*pending)(void), void (*dispatch)(void), int (*pollfd)(void));

#endif /* SCR_DGRAM_H */
