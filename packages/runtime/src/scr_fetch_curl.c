/* fetch for the dynamic island, over the system libcurl — the RETIRED
 * REFERENCE implementation. The default fetch is scr_fetch.c (scriptc's
 * own net stack: scr_net + scr_tls + scr_http's client parser + zlib);
 * this file stays compilable for one release behind SCRIPTC_FETCH_CURL=1
 * (native-toolchain.ts selects exactly one of the two — same scr_fetch_install symbol,
 * same island surface, same fixture contract) as the flip's reference,
 * the C-backend-vs-LLVM precedent. Compiled and linked ONLY into
 * --dynamic builds whose embedded npm graph references fetch (emit gates
 * on moduleUsesFetch; the emitted main calls scr_fetch_install before
 * any island entry) — fetch-free binaries keep their exact link line and
 * never load libcurl.
 *
 * Architecture (SEMANTICS.md has the user-facing story):
 * - The JS half (fetch_glue below) defines globalThis.fetch over two host
 *   functions: host.start(req, cbs) begins a transfer and host.abort(id)
 *   cancels one (response-body cancel). fetch() returns a REAL island
 *   promise; the Response's body is an island ReadableStream fed by
 *   C→engine callbacks as data arrives.
 * - The C half drives curl_multi from the event loop's io hook, exactly
 *   like child_process's waitpid polling: at loop quiescence the island's
 *   io poll (scr_island.c) drains engine jobs, then calls scr_fetch_poll,
 *   which SLEEPS on curl's fds (curl_multi_poll, capped by the loop's next
 *   deadline), performs transfers, fires callbacks for arrived data, and
 *   the drain that follows runs the resolved .then chains. The loop stays
 *   alive while transfers are live (scr_fetch_pending).
 * - fetch SEMANTICS, matched to Node/undici: HTTP errors RESOLVE (only
 *   network failure rejects, with TypeError "fetch failed" — Node's exact
 *   message); redirects are followed (curl FOLLOWLOCATION, 20 hops like
 *   fetch's limit, POST→GET rewriting on 301/302/303 per libcurl's
 *   default, response.url = the final URL, response.redirected set);
 *   status/headers surface at header-complete, the body streams; gzip
 *   arrives decompressed (ACCEPT_ENCODING "") like fetch. AbortSignal is
 *   wired (init.signal, or the Request's): an already-aborted signal
 *   rejects with its reason before any transfer starts; aborting a live
 *   transfer cancels the curl handle through host.abort (silent on the C
 *   side — the glue owns the rejection) and rejects the fetch promise —
 *   or errors the body stream when the response already resolved — with
 *   signal.reason (default: DOMException AbortError "This operation was
 *   aborted", Node's exact shape; AbortSignal.timeout's TimeoutError rides
 *   the island timer machinery in scr_web.c, its deadline capping the
 *   transfer poll's sleep below).
 * - Ownership: each transfer owns +1 on its JS callbacks object and its
 *   header/body copies; everything is freed when the transfer finishes,
 *   and teardown (registered with the island) frees whatever is still
 *   live before the engine goes down, so the island audit stays zero.
 */
#ifdef SCR_DYNAMIC

#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include <curl/curl.h>

#include "quickjs.h"

/* ── transfers ───────────────────────────────────────────────────────── */

typedef struct FxTransfer {
  int id;
  CURL *easy;
  JSContext *ctx;
  JSValue cbs; /* { onResponse, onData, onEnd, onError } — owned */
  struct curl_slist *req_headers;
  /* The CURRENT response block's status line + headers (a redirect hop or
   * 1xx resets it — only the final block reaches the island). */
  long status;
  char *status_text;
  char **hdr; /* name,value alternating */
  size_t nhdr, hdr_cap;
  bool responded; /* onResponse fired */
  bool cancelled; /* island cancelled the body stream */
  char errbuf[CURL_ERROR_SIZE];
  struct FxTransfer *next;
} FxTransfer;

static CURLM *fx_multi = NULL;
static FxTransfer *fx_live = NULL;
static size_t fx_nlive = 0;
static int fx_next_id = 1;
static bool fx_in_perform = false; /* abort-during-perform must defer */

static void fx_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

static void fx_headers_reset(FxTransfer *t) {
  for (size_t i = 0; i < t->nhdr; i++) free(t->hdr[i]);
  t->nhdr = 0;
  free(t->status_text);
  t->status_text = NULL;
  t->status = 0;
}

static void fx_free(FxTransfer *t) {
  fx_headers_reset(t);
  free(t->hdr);
  if (t->easy) {
    curl_multi_remove_handle(fx_multi, t->easy);
    curl_easy_cleanup(t->easy);
  }
  curl_slist_free_all(t->req_headers);
  JS_FreeValue(t->ctx, t->cbs);
  free(t);
}

static void fx_unlink(FxTransfer *t) {
  for (FxTransfer **link = &fx_live; *link; link = &(*link)->next) {
    if (*link == t) {
      *link = t->next;
      fx_nlive--;
      return;
    }
  }
}

/* Calls one callback off the cbs object, swallowing (but reporting) any
 * engine exception — the callbacks are our own glue and must not throw;
 * dying here would take down a transfer for an internal bug. */
static void fx_call(FxTransfer *t, const char *name, int argc, JSValueConst *argv) {
  JSContext *ctx = t->ctx;
  JSValue fn = JS_GetPropertyStr(ctx, t->cbs, name);
  JSValue r = JS_Call(ctx, fn, JS_UNDEFINED, argc, argv);
  JS_FreeValue(ctx, fn);
  if (JS_IsException(r)) {
    JSValue e = JS_GetException(ctx);
    const char *msg = JS_ToCString(ctx, e);
    fprintf(stderr, "scriptc: fetch internal callback '%s' threw: %s\n", name,
            msg ? msg : "?");
    if (msg) JS_FreeCString(ctx, msg);
    JS_FreeValue(ctx, e);
    return;
  }
  JS_FreeValue(ctx, r);
}

/* status/headers → the island (fires once, lazily: at the first body byte
 * or at DONE, whichever comes first — a header block curl is about to
 * follow away from never fires). */
static void fx_fire_response(FxTransfer *t) {
  if (t->responded) return;
  t->responded = true;
  JSContext *ctx = t->ctx;
  JSValue hdrs = JS_NewArray(ctx);
  for (size_t i = 0; i < t->nhdr; i++) {
    JS_SetPropertyUint32(ctx, hdrs, (uint32_t)i, JS_NewString(ctx, t->hdr[i]));
  }
  char *eff = NULL;
  long redirects = 0;
  curl_easy_getinfo(t->easy, CURLINFO_EFFECTIVE_URL, &eff);
  curl_easy_getinfo(t->easy, CURLINFO_REDIRECT_COUNT, &redirects);
  JSValue argv[5] = {
      JS_NewInt32(ctx, (int32_t)t->status),
      JS_NewString(ctx, t->status_text ? t->status_text : ""),
      hdrs,
      JS_NewString(ctx, eff ? eff : ""),
      JS_NewBool(ctx, redirects > 0),
  };
  fx_call(t, "onResponse", 5, argv);
  for (int i = 0; i < 5; i++) JS_FreeValue(ctx, argv[i]);
}

/* ── curl callbacks (fired inside curl_multi_perform) ────────────────── */

static size_t fx_header_cb(char *buf, size_t size, size_t n, void *ud) {
  FxTransfer *t = (FxTransfer *)ud;
  size_t len = size * n;
  if (len >= 5 && strncmp(buf, "HTTP/", 5) == 0) {
    /* A new response block (initial, redirect hop, or post-1xx): reset. */
    fx_headers_reset(t);
    const char *sp = memchr(buf, ' ', len);
    if (sp) {
      t->status = strtol(sp + 1, NULL, 10);
      const char *reason = memchr(sp + 1, ' ', len - (size_t)(sp + 1 - buf));
      if (reason) {
        reason++;
        size_t rlen = len - (size_t)(reason - buf);
        while (rlen > 0 && (reason[rlen - 1] == '\r' || reason[rlen - 1] == '\n')) rlen--;
        t->status_text = malloc(rlen + 1);
        if (!t->status_text) fx_oom();
        memcpy(t->status_text, reason, rlen);
        t->status_text[rlen] = '\0';
      }
    }
    return len;
  }
  const char *colon = memchr(buf, ':', len);
  if (!colon || colon == buf) return len; /* the blank terminator, or junk */
  size_t nlen = (size_t)(colon - buf);
  const char *v = colon + 1;
  size_t vlen = len - nlen - 1;
  while (vlen > 0 && (*v == ' ' || *v == '\t')) { v++; vlen--; }
  while (vlen > 0 && (v[vlen - 1] == '\r' || v[vlen - 1] == '\n' || v[vlen - 1] == ' ' || v[vlen - 1] == '\t')) vlen--;
  if (t->nhdr + 2 > t->hdr_cap) {
    t->hdr_cap = t->hdr_cap ? t->hdr_cap * 2 : 16;
    t->hdr = realloc(t->hdr, t->hdr_cap * sizeof(char *));
    if (!t->hdr) fx_oom();
  }
  char *name = malloc(nlen + 1);
  char *value = malloc(vlen + 1);
  if (!name || !value) fx_oom();
  memcpy(name, buf, nlen);
  name[nlen] = '\0';
  memcpy(value, v, vlen);
  value[vlen] = '\0';
  t->hdr[t->nhdr++] = name;
  t->hdr[t->nhdr++] = value;
  return len;
}

static size_t fx_write_cb(char *ptr, size_t size, size_t n, void *ud) {
  FxTransfer *t = (FxTransfer *)ud;
  size_t len = size * n;
  if (t->cancelled) return 0; /* aborts the transfer (CURLE_WRITE_ERROR) */
  if (t->status >= 300 && t->status <= 399) {
    /* A redirect body curl is following away from: fetch never delivers
     * it. (A FINAL 3xx — no Location — ends with an empty body here; the
     * documented corner.) */
    return len;
  }
  fx_fire_response(t);
  JSValue chunk = JS_NewUint8ArrayCopy(t->ctx, (const uint8_t *)ptr, len);
  fx_call(t, "onData", 1, (JSValueConst *)&chunk);
  JS_FreeValue(t->ctx, chunk);
  return len;
}

/* ── completion ──────────────────────────────────────────────────────── */

static void fx_finish(FxTransfer *t, CURLcode result) {
  if (t->cancelled) {
    /* The island cancelled the body: nothing to deliver. */
  } else if (result == CURLE_OK) {
    fx_fire_response(t); /* bodyless responses respond here */
    fx_call(t, "onEnd", 0, NULL);
  } else {
    /* Node's fetch failure carries a CAUSE (undici): a plain Error whose
     * message/code the AI-SDK-style wrappers read (`error.cause.message`,
     * the ECONNREFUSED classification). Shape the two common network
     * failures exactly like Node — connect ECONNREFUSED host:port and
     * getaddrinfo ENOTFOUND host — and pass everything else through as
     * curl's detail string. (Node also sets errno/address/port on the
     * cause; those stay off — a documented approximation.) */
    const char *detail = t->errbuf[0] ? t->errbuf : curl_easy_strerror(result);
    const char *code = NULL;
    char shaped[512];
    if (result == CURLE_COULDNT_CONNECT || result == CURLE_COULDNT_RESOLVE_HOST) {
      char *eff = NULL;
      curl_easy_getinfo(t->easy, CURLINFO_EFFECTIVE_URL, &eff);
      CURLU *u = curl_url();
      char *host = NULL, *port = NULL, *scheme = NULL;
      if (u && eff && curl_url_set(u, CURLUPART_URL, eff, 0) == CURLUE_OK) {
        curl_url_get(u, CURLUPART_HOST, &host, 0);
        curl_url_get(u, CURLUPART_PORT, &port, 0);
        curl_url_get(u, CURLUPART_SCHEME, &scheme, 0);
      }
      const char *h = host ? host : "";
      const char *p = port ? port
                    : (scheme && strcmp(scheme, "https") == 0 ? "443" : "80");
      if (result == CURLE_COULDNT_CONNECT) {
        snprintf(shaped, sizeof shaped, "connect ECONNREFUSED %s:%s", h, p);
        code = "ECONNREFUSED";
      } else {
        snprintf(shaped, sizeof shaped, "getaddrinfo ENOTFOUND %s", h);
        code = "ENOTFOUND";
      }
      detail = shaped;
      if (host) curl_free(host);
      if (port) curl_free(port);
      if (scheme) curl_free(scheme);
      if (u) curl_url_cleanup(u);
    }
    JSValue args[2];
    args[0] = JS_NewString(t->ctx, detail);
    args[1] = code ? JS_NewString(t->ctx, code) : JS_UNDEFINED;
    fx_call(t, "onError", 2, (JSValueConst *)args);
    JS_FreeValue(t->ctx, args[0]);
    JS_FreeValue(t->ctx, args[1]);
  }
  fx_free(t);
}

/* ── the loop's fetch half (called from scr_island.c's io poll) ───────── */

static bool fx_pending(void) { return fx_nlive > 0; }

static void fx_poll(double max_wait_ms) {
  if (fx_nlive == 0) return;
  if (max_wait_ms > 0) {
    int ms = max_wait_ms > 1000 ? 1000 : (int)max_wait_ms;
    curl_multi_poll(fx_multi, NULL, 0, ms, NULL);
  }
  int running = 0;
  fx_in_perform = true;
  curl_multi_perform(fx_multi, &running);
  fx_in_perform = false;
  for (;;) {
    int left = 0;
    CURLMsg *msg = curl_multi_info_read(fx_multi, &left);
    if (!msg) break;
    if (msg->msg != CURLMSG_DONE) continue;
    FxTransfer *t = NULL;
    curl_easy_getinfo(msg->easy_handle, CURLINFO_PRIVATE, &t);
    if (!t) continue;
    fx_unlink(t);
    fx_finish(t, msg->data.result);
  }
}

/* ── host functions (called by the fetch glue, inside the engine) ────── */

/* host.start({url, method, headers: [n,v,...], body: Uint8Array|undefined},
 * cbs) → transfer id. Everything is copied out of the engine before curl
 * sees it. */
static JSValue fx_host_start(JSContext *ctx, JSValueConst this_val, int argc,
                             JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  JSValueConst req = argv[0];
  FxTransfer *t = calloc(1, sizeof *t);
  if (!t) fx_oom();
  t->ctx = ctx;
  t->id = fx_next_id++;
  t->cbs = JS_DupValue(ctx, argv[1]);
  t->easy = curl_easy_init();
  if (!t->easy) {
    JS_FreeValue(ctx, t->cbs);
    free(t);
    return JS_ThrowTypeError(ctx, "fetch failed");
  }
  CURL *e = t->easy;

  JSValue urlv = JS_GetPropertyStr(ctx, req, "url");
  const char *url = JS_ToCString(ctx, urlv);
  JS_FreeValue(ctx, urlv);
  JSValue methodv = JS_GetPropertyStr(ctx, req, "method");
  const char *method = JS_ToCString(ctx, methodv);
  JS_FreeValue(ctx, methodv);
  if (!url || !method) {
    if (url) JS_FreeCString(ctx, url);
    if (method) JS_FreeCString(ctx, method);
    fx_free(t);
    return JS_EXCEPTION;
  }

  curl_easy_setopt(e, CURLOPT_URL, url);
  curl_easy_setopt(e, CURLOPT_PRIVATE, t);
  curl_easy_setopt(e, CURLOPT_WRITEFUNCTION, fx_write_cb);
  curl_easy_setopt(e, CURLOPT_WRITEDATA, t);
  curl_easy_setopt(e, CURLOPT_HEADERFUNCTION, fx_header_cb);
  curl_easy_setopt(e, CURLOPT_HEADERDATA, t);
  curl_easy_setopt(e, CURLOPT_ERRORBUFFER, t->errbuf);
  curl_easy_setopt(e, CURLOPT_NOSIGNAL, 1L);
  curl_easy_setopt(e, CURLOPT_FOLLOWLOCATION, 1L);
  curl_easy_setopt(e, CURLOPT_MAXREDIRS, 20L); /* fetch's redirect limit */
  curl_easy_setopt(e, CURLOPT_ACCEPT_ENCODING, ""); /* gzip in, transparent out */
  curl_easy_setopt(e, CURLOPT_PROTOCOLS_STR, "http,https");
  curl_easy_setopt(e, CURLOPT_SUPPRESS_CONNECT_HEADERS, 1L);
  /* Node's global opt-in and Vercel's request-local EnvProxyDispatcher both
   * activate libcurl's environment proxy lookup. Otherwise explicitly turn
   * it off, because libcurl enables proxy variables by default. */
  JSValue envproxyv = JS_GetPropertyStr(ctx, req, "useEnvProxy");
  bool use_env_proxy = JS_ToBool(ctx, envproxyv) > 0;
  JS_FreeValue(ctx, envproxyv);
  const char *global_env_proxy = getenv("NODE_USE_ENV_PROXY");
  use_env_proxy = use_env_proxy ||
                  (global_env_proxy != NULL &&
                   strcmp(global_env_proxy, "1") == 0);
  if (!use_env_proxy) {
    curl_easy_setopt(e, CURLOPT_PROXY, "");
  }

  /* Request headers: fetch never sends Expect: 100-continue; a body with
   * no explicit content-type must not inherit curl's form default. */
  bool has_content_type = false;
  JSValue hdrs = JS_GetPropertyStr(ctx, req, "headers");
  JSValue lenv = JS_GetPropertyStr(ctx, hdrs, "length");
  uint32_t hn = 0;
  JS_ToUint32(ctx, &hn, lenv);
  JS_FreeValue(ctx, lenv);
  for (uint32_t i = 0; i + 1 < hn; i += 2) {
    JSValue nv = JS_GetPropertyUint32(ctx, hdrs, i);
    JSValue vv = JS_GetPropertyUint32(ctx, hdrs, i + 1);
    const char *hname = JS_ToCString(ctx, nv);
    const char *hvalue = JS_ToCString(ctx, vv);
    if (hname && hvalue) {
      if (strcasecmp(hname, "content-type") == 0) has_content_type = true;
      size_t linelen = strlen(hname) + 2 + strlen(hvalue) + 1;
      char *line = malloc(linelen);
      if (!line) fx_oom();
      /* An empty value still SETS the header: curl's "name;" form. */
      if (hvalue[0] == '\0') snprintf(line, linelen, "%s;", hname);
      else snprintf(line, linelen, "%s: %s", hname, hvalue);
      t->req_headers = curl_slist_append(t->req_headers, line);
      free(line);
    }
    if (hname) JS_FreeCString(ctx, hname);
    if (hvalue) JS_FreeCString(ctx, hvalue);
    JS_FreeValue(ctx, nv);
    JS_FreeValue(ctx, vv);
  }
  JS_FreeValue(ctx, hdrs);
  t->req_headers = curl_slist_append(t->req_headers, "Expect:");

  /* Body: copied by COPYPOSTFIELDS; binary-safe via POSTFIELDSIZE. */
  JSValue bodyv = JS_GetPropertyStr(ctx, req, "body");
  if (!JS_IsUndefined(bodyv) && !JS_IsNull(bodyv)) {
    size_t blen = 0;
    uint8_t *bytes = JS_GetUint8Array(ctx, &blen, bodyv);
    if (bytes || blen == 0) {
      curl_easy_setopt(e, CURLOPT_POSTFIELDSIZE, (long)blen);
      curl_easy_setopt(e, CURLOPT_COPYPOSTFIELDS, (const char *)bytes);
      if (!has_content_type) {
        t->req_headers = curl_slist_append(t->req_headers, "Content-Type:");
      }
    }
  }
  JS_FreeValue(ctx, bodyv);

  /* Method: bodies default curl to POST; anything else is CUSTOMREQUEST.
   * HEAD is NOBODY so curl won't wait for a body that never comes. */
  if (strcasecmp(method, "HEAD") == 0) {
    curl_easy_setopt(e, CURLOPT_NOBODY, 1L);
  } else if (strcasecmp(method, "GET") != 0 && strcasecmp(method, "POST") != 0) {
    curl_easy_setopt(e, CURLOPT_CUSTOMREQUEST, method);
  }
  curl_easy_setopt(e, CURLOPT_HTTPHEADER, t->req_headers);

  JS_FreeCString(ctx, url);
  JS_FreeCString(ctx, method);

  t->next = fx_live;
  fx_live = t;
  fx_nlive++;
  curl_multi_add_handle(fx_multi, t->easy);
  return JS_NewInt32(ctx, t->id);
}

/* host.abort(id): the island cancelled the response body stream. The
 * transfer dies quietly — no onError, no onEnd. */
static JSValue fx_host_abort(JSContext *ctx, JSValueConst this_val, int argc,
                             JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  int32_t id = 0;
  JS_ToInt32(ctx, &id, argv[0]);
  for (FxTransfer *t = fx_live; t; t = t->next) {
    if (t->id == id) {
      if (fx_in_perform) {
        /* curl frames are live on the stack: the write callback returns 0
         * next delivery, the transfer errors out, and fx_finish sees
         * `cancelled` and dies silently. */
        t->cancelled = true;
      } else {
        fx_unlink(t);
        fx_free(t);
      }
      break;
    }
  }
  return JS_UNDEFINED;
}

/* ── the JS half ─────────────────────────────────────────────────────── */

static const char fx_glue[] =
    "(host) => {\n"
    "  'use strict';\n"
    "  const g = globalThis;\n"
    "  const NULL_BODY = { 204: true, 205: true, 304: true };\n"
    "  g.fetch = function fetch(input, init) {\n"
    "    return new Promise((resolve, reject) => {\n"
    "      let url;\n"
    "      let method = 'GET';\n"
    "      let headers = null;\n"
    "      let body = null;\n"
    "      let signal = null;\n"
    "      if (input instanceof g.Request) {\n"
    "        url = input.url;\n"
    "        method = input.method;\n"
    "        headers = new g.Headers(input.headers);\n"
    "        body = input._body instanceof Uint8Array ? input._body : null;\n"
    "        signal = input._signal;\n"
    "      } else {\n"
    "        url = String(input);\n"
    "      }\n"
    "      init = init === undefined || init === null ? {} : init;\n"
    "      let useEnvProxy = g.process?.env?.NODE_USE_ENV_PROXY === '1';\n"
    "      const initDispatcher = init.dispatcher;\n"
    "      if (initDispatcher !== undefined) {\n"
    "        const dispatcher = initDispatcher;\n"
    "        const methods = ['dispatch', 'close', 'destroy', 'agents', 'getAgent', 'shouldProxy', 'parseNoProxy'];\n"
    "        const known = dispatcher !== null && typeof dispatcher === 'object' && dispatcher.constructor?.name === 'EnvProxyDispatcher' && methods.every((member) => typeof dispatcher[member] === 'function');\n"
    "        if (!known) throw new TypeError('unsupported RequestInit option: dispatcher');\n"
    "        useEnvProxy = true;\n"
    "      }\n"
    "      // An explicit init.signal overrides the Request's, null included.\n"
    "      if (init.signal !== undefined) {\n"
    "        if (init.signal !== null && !(init.signal instanceof g.AbortSignal)) {\n"
    "          throw new TypeError('fetch init.signal must be an AbortSignal or null');\n"
    "        }\n"
    "        signal = init.signal;\n"
    "      }\n"
    "      if (init.redirect !== undefined && init.redirect !== 'follow') {\n"
    "        throw new Error(\"scriptc: only redirect: 'follow' is supported by the embedded fetch\");\n"
    "      }\n"
    "      // Reuse Request's init handling: method normalization, header\n"
    "      // collection, body coercion with its implicit content-type, and the\n"
    "      // GET/HEAD-with-body TypeError.\n"
    "      const reqInit = {};\n"
    "      if (init.method !== undefined) reqInit.method = init.method;\n"
    "      if (init.headers !== undefined) reqInit.headers = init.headers;\n"
    "      if (init.body !== undefined && init.body !== null) reqInit.body = init.body;\n"
    "      if (reqInit.method !== undefined || reqInit.headers !== undefined || reqInit.body !== undefined || headers === null) {\n"
    "        const base = input instanceof g.Request ? input : url;\n"
    "        const r = new g.Request(base, reqInit);\n"
    "        method = r.method;\n"
    "        headers = r.headers;\n"
    "        if (r._body instanceof Uint8Array) body = r._body;\n"
    "      }\n"
    "      if (body !== null && !(body instanceof Uint8Array)) {\n"
    "        throw new TypeError('streaming request bodies are not supported in the scriptc island');\n"
    "      }\n"
    "      // An already-aborted signal rejects with ITS reason before any\n"
    "      // transfer starts (Node: validation above still throws first).\n"
    "      if (signal !== null && signal.aborted) {\n"
    "        reject(signal.reason);\n"
    "        return;\n"
    "      }\n"
    "      let controller = null;\n"
    "      let resolved = false;\n"
    "      let done = false;\n"
    "      let id = 0;\n"
    "      // The transfer is over (delivered, failed, cancelled, or aborted):\n"
    "      // a later signal abort must not touch it.\n"
    "      const finish = () => {\n"
    "        done = true;\n"
    "        if (signal !== null) signal.removeEventListener('abort', onAbort);\n"
    "      };\n"
    "      const onAbort = () => {\n"
    "        if (done) return;\n"
    "        finish();\n"
    "        host.abort(id); // the C side dies quietly; rejection is ours\n"
    "        if (!resolved) {\n"
    "          resolved = true;\n"
    "          reject(signal.reason);\n"
    "        } else if (controller !== null) {\n"
    "          // Mid-stream: pending and future reads reject with the reason,\n"
    "          // exactly Node's aborted-body behavior.\n"
    "          try { controller.error(signal.reason); } catch (_e) { /* already closed */ }\n"
    "          controller = null;\n"
    "        }\n"
    "      };\n"
    "      const flat = [];\n"
    "      for (const pair of headers) { flat.push(pair[0], pair[1]); }\n"
    "      id = host.start(\n"
    "        { url, method, headers: flat, body: body === null ? undefined : body, useEnvProxy },\n"
    "        {\n"
    "          onResponse(status, statusText, raw, finalUrl, redirected) {\n"
    "            resolved = true;\n"
    "            const h = new g.Headers();\n"
    "            for (let i = 0; i + 1 < raw.length; i += 2) {\n"
    "              try { h.append(raw[i], raw[i + 1]); } catch (_e) { /* junk line */ }\n"
    "            }\n"
    "            let stream = null;\n"
    "            if (method !== 'HEAD' && NULL_BODY[status] !== true) {\n"
    "              stream = new g.ReadableStream({\n"
    "                start(c) { controller = c; },\n"
    "                cancel() { controller = null; finish(); host.abort(id); },\n"
    "              });\n"
    "            }\n"
    "            resolve(g.__scr_mk_response(status, statusText, h, finalUrl, redirected, stream));\n"
    "          },\n"
    "          onData(chunk) {\n"
    "            if (controller !== null) {\n"
    "              try { controller.enqueue(chunk); } catch (_e) { /* consumer went away */ }\n"
    "            }\n"
    "          },\n"
    "          onEnd() {\n"
    "            finish();\n"
    "            if (controller !== null) {\n"
    "              try { controller.close(); } catch (_e) { /* already errored */ }\n"
    "              controller = null;\n"
    "            }\n"
    "          },\n"
    "          onError(detail, code) {\n"
    "            finish();\n"
    "            if (!resolved) {\n"
    "              // Node's shape: TypeError 'fetch failed' with a CAUSE the\n"
    "              // wrappers classify (message + code for the network cases).\n"
    "              const cause = new Error(String(detail));\n"
    "              if (code !== undefined) cause.code = code;\n"
    "              if (code === 'ECONNREFUSED') cause.syscall = 'connect';\n"
    "              else if (code === 'ENOTFOUND') cause.syscall = 'getaddrinfo';\n"
    "              const err = new TypeError('fetch failed');\n"
    "              err.cause = cause;\n"
    "              reject(err);\n"
    "            } else if (controller !== null) {\n"
    "              try { controller.error(new TypeError('terminated')); } catch (_e) { /* already closed */ }\n"
    "              controller = null;\n"
    "            }\n"
    "          },\n"
    "        },\n"
    "      );\n"
    "      if (signal !== null) signal.addEventListener('abort', onAbort, { once: true });\n"
    "    });\n"
    "  };\n"
    "}\n";

/* ── boot / teardown (registered with the island) ────────────────────── */

static void fx_boot(void *jsctx) {
  JSContext *ctx = (JSContext *)jsctx;
  JSValue fn = JS_Eval(ctx, fx_glue, sizeof fx_glue - 1, "<scr-fetch>", JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(fn)) {
    fprintf(stderr, "scriptc: island fetch glue failed to evaluate\n");
    abort();
  }
  JSValue host = JS_NewObject(ctx);
  JS_SetPropertyStr(ctx, host, "start", JS_NewCFunction(ctx, fx_host_start, "start", 2));
  JS_SetPropertyStr(ctx, host, "abort", JS_NewCFunction(ctx, fx_host_abort, "abort", 1));
  JSValue r = JS_Call(ctx, fn, JS_UNDEFINED, 1, (JSValueConst *)&host);
  JS_FreeValue(ctx, host);
  JS_FreeValue(ctx, fn);
  if (JS_IsException(r)) {
    fprintf(stderr, "scriptc: island fetch glue failed to run\n");
    abort();
  }
  JS_FreeValue(ctx, r);
}

/* Engine teardown with transfers still live (process.exit mid-request, or
 * an exit with an abandoned body stream): free their engine values FIRST
 * so the island's counting allocator returns to zero. */
static void fx_teardown(void) {
  while (fx_live) {
    FxTransfer *t = fx_live;
    fx_live = t->next;
    fx_nlive--;
    fx_free(t);
  }
  if (fx_multi) {
    curl_multi_cleanup(fx_multi);
    fx_multi = NULL;
  }
  curl_global_cleanup();
}

/* The emitted main calls this (before any island entry) in builds whose
 * embedded graph references fetch. */
void scr_fetch_install(void) {
  if (fx_multi) return;
  curl_global_init(CURL_GLOBAL_DEFAULT);
  fx_multi = curl_multi_init();
  if (!fx_multi) {
    fputs("scriptc: curl_multi_init failed\n", stderr);
    abort();
  }
  scr_island_set_fetch(fx_boot, fx_pending, fx_poll, fx_teardown);
}

#endif /* SCR_DYNAMIC */
