/* scriptc runtime — the global WebSocket client (scr_websocket.c). Included
 * by scr_runtime.h, which says where new declarations go. */
#ifndef SCR_WEBSOCKET_H
#define SCR_WEBSOCKET_H

#include "scr_dyn.h"

/* new WebSocket(url[, protocols]): both arguments are borrowed checked-
 * dynamic values, coerced and validated like Node's constructor (the URL
 * through the WHATWG parser, the subprotocol tokens against RFC 6455).
 * +1 handle, or NULL with Node's DOMException (or the missing-argument
 * TypeError) pending; the handshake continues on the event loop and
 * reports through the socket's events. */
ScrDyn *scr_websocket_new(ScrDyn *url, ScrDyn *protocols);

/* `value instanceof WebSocket`: true for the runtime's socket handles. */
bool scr_websocket_is(const ScrDyn *value);

#endif /* SCR_WEBSOCKET_H */
