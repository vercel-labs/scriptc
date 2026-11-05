/* scriptc runtime — options.checkServerIdentity (node:tls, node:https).
 *
 * Node calls the option's function once the TLS handshake stands, with
 * the servername and the peer certificate (getPeerCertificate(true)); a
 * truthy answer fails the connection with that error. Building the
 * certificate needs scr_tls_x509.c and scr_x509.c, so this unit is linked
 * only for programs whose source carries the option (the compiler picks
 * the *_identity entries); scr_tls.c keeps a hook that is NULL otherwise
 * and the option keeps its fence there. */
#include "scr_runtime.h"

#include <string.h>

/* The hook scr_tls.c's handshake calls: (servername, PeerCertificate) ->
 * the function's answer (+1, NULL with the exception pending). */
static ScrDyn *scr_tls_identity_run(ScrNetSocket *s, ScrDyn *fn, const char *name) {
  ScrDyn *cert = scr_tls_sock_get_peer_certificate(s, scr_dyn_new_bool(true));
  ScrStr *text = scr_str_new(name, strlen(name));
  ScrDyn *args[2] = {scr_dyn_new_str(text), cert};
  scr_str_release(text);
  ScrDyn *answer = scr_dyn_call(fn, args, 2, "options.checkServerIdentity");
  scr_dyn_release(args[0]);
  scr_dyn_release(cert);
  return answer;
}

static void scr_tls_identity_install(void) {
  scr_tls_install_identity_runner(&scr_tls_identity_run);
}

/* https.request's literal-path step (the servername pattern): Node
 * validates the option where tls.connect reads it, a PRESENT key holding
 * anything but a function (undefined included) throwing now. */
void scr_tls_identity_next(const ScrDyn *fn /*borrowed*/) {
  if (fn->kind != SCR_DYN_FUNC) {
    scr_dyn_prop_type_fail("options.checkServerIdentity", "of type function", fn);
    return;
  }
  scr_tls_identity_install();
  scr_tls_set_next_identity(fn);
}

ScrNetSocket *scr_tls_identity_connect(double port, ScrStr *host /*borrowed, nullable*/,
                                        const ScrDyn *opts /*borrowed, nullable*/,
                                        ScrClosure *cb /*moves, nullable*/) {
  scr_tls_identity_install();
  return scr_tls_connect_dyn_identity(port, host, opts, cb);
}

ScrHttpClientReq *scr_tls_identity_https_request(const ScrDyn *opts /*borrowed*/, bool auto_end,
                                                  ScrClosure *cb /*moves, nullable*/,
                                                  ScrHttpRespFn fn,
                                                  ScrDyn *(*add_abort)(ScrDyn *signal,
                                                                       ScrDyn *listener)) {
  scr_tls_identity_install();
  return scr_https_request_dyn_impl(opts, auto_end, cb, fn, add_abort, true);
}

ScrHttpClientReq *scr_tls_identity_https_request_url(const ScrStr *url /*borrowed*/,
                                                      const ScrDyn *opts /*borrowed*/, bool auto_end,
                                                      ScrClosure *cb /*moves, nullable*/,
                                                      ScrHttpRespFn fn,
                                                      ScrDyn *(*add_abort)(ScrDyn *signal,
                                                                           ScrDyn *listener)) {
  scr_tls_identity_install();
  return scr_https_request_url_dyn_impl(url, opts, auto_end, cb, fn, add_abort, true);
}
