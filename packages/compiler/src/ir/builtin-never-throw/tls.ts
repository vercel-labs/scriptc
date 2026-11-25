import type { IrLibFn } from "../builtin-signatures.js";

/** The builtins in the tls module decided never to throw. */
export const tlsNeverThrow: readonly IrLibFn[] = [
  // scr_tls_sock_dyn_member reads the name the client asked for (the SNI
  // name a server recorded) into a string, or false, and copies the
  // established session into a Buffer, or null before there is one. It
  // runs no program code.
  "tls.sockDynMember",
  // scr_tls_sock_disable_renegotiation does nothing: the provider keeps
  // renegotiation off, which is what the call asks for.
  "tls.sockDisableRenegotiation",
  // scr_net_server_is_tls and scr_tls_server_is_dyn read a handle's tag
  // for `instanceof tls.Server`; no program code runs.
  "tls.serverIs",
  "tls.serverIsDyn",
  // 'keylog' registration only appends the listener to the socket's or the
  // TLS server's list: no program code runs at the add.
  "tls.sockOnKeylog",
  "tls.serverOnKeylog",
  // scr_tls_sock_get_tls_ticket copies the session's ticket into a Buffer,
  // or answers undefined; no program code runs.
  "tls.sockGetTlsTicket",
];
