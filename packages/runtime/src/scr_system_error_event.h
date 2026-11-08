#ifndef SCR_SYSTEM_ERROR_EVENT_H
#define SCR_SYSTEM_ERROR_EVENT_H
/* Node's system error for a failure message the net, http and dgram units
 * write. Those units report a failed bind, listen, connect, send or lookup
 * as the message Node builds from the failure, so the error object is
 * rebuilt from that text in one place: these functions. Each unit that fires
 * such messages includes this header after its socket headers (the
 * function is static: a dgram program links no net unit). */
#include "scr_dyn.h"
#include "scr_error.h"
#include "scr_system_errors.h"

#include <stdlib.h>
#include <string.h>

/* libuv's errors by name: the number Node reports as err.errno and the
 * message of the "<syscall> <CODE>: <message>" form. */
typedef struct { int value; const char *name; const char *message; } ScrUvError;
#define SCR_UV_ERROR_ROW(name, message) { SCR_NODE_UV__##name, #name, message },
static const ScrUvError scr_uv_errors[] = { SCR_NODE_UV_ERRNO_MAP(SCR_UV_ERROR_ROW) };
#undef SCR_UV_ERROR_ROW

/* The entry of an error code name, or NULL for a name outside libuv's map. */
static const ScrUvError *scr_uv_error_named(const char *name, size_t len) {
  for (size_t i = 0; i < sizeof scr_uv_errors / sizeof scr_uv_errors[0]; i++) {
    if (strlen(scr_uv_errors[i].name) == len && memcmp(scr_uv_errors[i].name, name, len) == 0)
      return &scr_uv_errors[i];
  }
  return NULL;
}

/* The libuv errno of an error code name (Node's err.errno), 0 for a name
 * outside libuv's map. */
static double scr_net_uv_errno(const char *code, size_t len) {
  const ScrUvError *known = scr_uv_error_named(code, len);
  if (known != NULL) return known->value;
  /* Node names getaddrinfo's EAI_NONAME (and EAI_NODATA) ENOTFOUND and
   * keeps libuv's number. */
  if (len == 9 && memcmp(code, "ENOTFOUND", 9) == 0) return SCR_NODE_UV__EAI_NONAME;
  return 0;
}

/* The libuv message of an error code name, or NULL. */
static const char *scr_net_uv_text(const char *code, size_t len) {
  const ScrUvError *known = scr_uv_error_named(code, len);
  return known != NULL ? known->message : NULL;
}

static bool scr_system_error_word(const char *data, size_t len, const char *word) {
  return len == strlen(word) && memcmp(data, word, len) == 0;
}

/* The message forms:
 * "<syscall> <CODE>[ <detail>]" (errnoException, exceptionWithHostPort,
 * DNSException) or "<syscall> <CODE>: <libuv message>[ <detail>]"
 * (uvExceptionWithHostPort). This is the part of the error that lives in
 * the error itself: the code, the libuv errno and the syscall. *detail is
 * where the message's detail starts (its end when there is none). NULL
 * for any other message; +1 otherwise. It names nothing of the dynamic
 * object model, so a unit that typed programs link can call it. */
static ScrError *scr_system_error_fields(ScrStr *msg, const char **detail_out) {
  const char *data = msg->data;
  const char *end = data + msg->len;
  const char *space = memchr(data, ' ', msg->len);
  if (space == NULL || space == data) return NULL;
  size_t syscall_len = (size_t)(space - data);
  const char *code = space + 1;
  const char *code_end = code;
  while (code_end < end && *code_end != ' ' && *code_end != ':') code_end++;
  size_t code_len = (size_t)(code_end - code);
  if (code_len < 2 || code[0] != 'E') return NULL;
  for (size_t i = 0; i < code_len; i++) {
    char c = code[i];
    if (!((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_')) return NULL;
  }
  double uv = scr_net_uv_errno(code, code_len);
  if (uv == 0) return NULL;
  const char *detail = code_end;
  if (detail < end && *detail == ':') {
    /* the libuv form: skip ": <message>" */
    const char *text = scr_net_uv_text(code, code_len);
    size_t text_len = text != NULL ? strlen(text) : 0;
    if (text == NULL || (size_t)(end - detail) < 2 + text_len ||
        memcmp(detail + 2, text, text_len) != 0)
      return NULL;
    detail += 2 + text_len;
  }
  if (detail < end && *detail == ' ') detail++;
  ScrError *e = scr_error_new(SCR_ERR_ERROR, msg);
  char code_buf[32];
  size_t n = code_len < sizeof code_buf - 1 ? code_len : sizeof code_buf - 1;
  memcpy(code_buf, code, n);
  code_buf[n] = '\0';
  scr_error_set_code(e, code_buf);
  e->system_errno = uv;
  e->system_call = scr_str_new(data, syscall_len);
  *detail_out = detail;
  return e;
}

/* scr_system_error_fields, and the properties the detail names: for
 * connect, listen, bind and send the address, as "<address>:<port>" with
 * a port, and a listen on a pipe path has port -1; for getaddrinfo the
 * hostname. They are own properties of the error's untyped view, so this
 * function links the dynamic object model. */
static ScrError *scr_system_error_from_message(ScrStr *msg) {
  const char *detail;
  ScrError *e = scr_system_error_fields(msg, &detail);
  if (e == NULL) return NULL;
  const char *data = msg->data;
  const char *end = data + msg->len;
  size_t syscall_len = e->system_call->len;
  if (scr_system_error_word(data, syscall_len, "getaddrinfo")) {
    if (detail < end) {
      ScrStr *hostname = scr_str_new(detail, (size_t)(end - detail));
      scr_error_set_prop(e, "hostname", 8, scr_dyn_new_str(hostname));
      scr_str_release(hostname);
    }
    return e;
  }
  bool listen = scr_system_error_word(data, syscall_len, "listen");
  bool with_address = listen || scr_system_error_word(data, syscall_len, "connect") ||
                      scr_system_error_word(data, syscall_len, "bind") ||
                      scr_system_error_word(data, syscall_len, "send");
  if (with_address && detail < end) {
    const char *colon = NULL;
    for (const char *q = detail; q < end; q++)
      if (*q == ':') colon = q;
    bool digits = colon != NULL && colon + 1 < end;
    for (const char *q = colon != NULL ? colon + 1 : end; q < end; q++)
      if (*q < '0' || *q > '9') digits = false;
    const char *address_end = digits ? colon : end;
    ScrStr *address = scr_str_new(detail, (size_t)(address_end - detail));
    scr_error_set_prop(e, "address", 7, scr_dyn_new_str(address));
    /* a pipe listen: Node's listenInCluster passes port -1 with the path */
    bool pipe_listen = false;
    if (!digits && listen) {
      unsigned char ip[16];
      pipe_listen = inet_pton(AF_INET, address->data, ip) != 1 &&
                    inet_pton(AF_INET6, address->data, ip) != 1;
    }
    scr_str_release(address);
    if (digits) scr_error_set_prop(e, "port", 4, scr_dyn_new_num(strtod(colon + 1, NULL)));
    else if (pipe_listen) scr_error_set_prop(e, "port", 4, scr_dyn_new_num(-1));
  }
  return e;
}

#endif /* SCR_SYSTEM_ERROR_EVENT_H */
