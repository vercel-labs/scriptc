/* node:midi — MIDI input/output ports over the event loop's readiness
 * poller (the scr_platform.h contract — kqueue on macOS/BSD, epoll on
 * Linux, WSAPoll on win32; scr_dgram.c has the seam's full story). The
 * de-facto Node surface is node-midi / @julusian/midi (RtMidi under the
 * hood); this unit ports its CORE messaging shape — enumerate, open
 * (incl. virtual ports), receive time-stamped messages via 'message',
 * send raw bytes — modeled touchpoint-for-touchpoint on scr_dgram.c.
 *
 * ── Design note ──────────────────────────────────────────────────────
 *
 * Object model. Two refcounted handle kinds, LEAN allocations (the
 * ScrDgramSocket precedent, no cycle header): ScrMidiInput (a live,
 * pollable source, like a bound socket) and ScrMidiOutput (fire-and-
 * forget, like a connected UDP sender). Both start with a `kind` tag as
 * their first member, so the shared ABI symbols take a void* handle and
 * route on that tag (scr_net.c's leading-int-in-udata technique). A
 * 'message' listener MOVES in (+1) and is released when the input closes
 * or at the exit-time cleanup — the dgram ownership story verbatim, so a
 * listener capturing its own input cannot cycle past close.
 *
 * Event dispatch. One poller owned by this unit (lazily created). The
 * loop (scr_async.c) calls scr_midi_dispatch() at every turn top — the
 * dgram hook's exact shape — draining the poller (a zero-timeout pass)
 * then firing 'message' emits macrotask-style on the MAIN stack, stopping
 * early when a listener enqueued microtasks or threw. Between turns the
 * loop's idle poll(2) watches this unit's poller fd.
 *
 * The off-thread bridge (the mandatory rule). CoreMIDI and WinMM deliver
 * their read callbacks on a PLATFORM thread, never the loop thread. Those
 * callbacks are forbidden from touching the runtime heap (no ScrArr /
 * ScrStr / closures, no refcounts) — they only COPY the raw bytes into a
 * per-input, lock-guarded ring (plain libc malloc, which is thread-safe
 * and is NOT the GC heap) and write ONE byte to a self-pipe whose read
 * end is registered with the poller. All JS-visible work — building the
 * number[], computing deltaTime, firing listeners — happens later in
 * scr_midi_dispatch on the loop thread. ALSA's fds are pollable directly,
 * so its "callback" is just the loop-thread decode in the same pump; it
 * uses the same ring for one drain path.
 *
 * Read model. Consumer-like: the input's platform source stays open once
 * opened (node-midi keeps the port live regardless of listeners), but the
 * ring only fills while the source runs; messages fire in arrival order,
 * one 'message' emit per message, the byte run delivered as a number[]
 * (the node-midi shape) with deltaTime the leading f64. `once` listeners
 * leave the live list before firing (the dgram snapshot discipline).
 *
 * Delta-time. Each input tracks the timestamp of its previous delivered
 * message and reports deltaTime in SECONDS (node-midi's unit). The first
 * message after open reports 0. The timestamp is captured at enqueue with
 * a monotonic clock (the platform packet time where a backend has it).
 *
 * ignoreTypes(sysex, timing, activeSensing). Applied at fire time on the
 * loop thread by inspecting the status byte (RtMidi's filter): sysex =
 * 0xF0, timing = 0xF8 clock and 0xF1 MTC quarter-frame, activeSensing =
 * 0xFE. node-midi's default is (true, true, true) — set at construction.
 *
 * Send model. sendMessage writes immediately — a MIDI message either goes
 * out or it doesn't; there is no buffering. Short channel/system messages
 * take the platform short path (midiOutShortMsg / a 3-byte packet); a
 * SysEx run takes the long path (midiOutLongMsg / snd_midi_event / a
 * variable packet).
 *
 * Virtual ports (the hardware-free loopback §5 relies on). POSIX only:
 * ALSA creates a native sequencer port other clients subscribe to;
 * CoreMIDI creates a MIDISource (an input's virtual is a destination we
 * publish, an output's virtual is a source we publish). WinMM has NO
 * user-space virtual ports, so openVirtualPort THROWS a clear runtime
 * error there (a documented divergence). A test opens a virtual output
 * named e.g. "scriptc-test", opens an input on that same virtual port,
 * sends a deterministic sequence, and compares — no hardware needed.
 *
 * Loop liveness. An OPEN input holds the loop alive until closePort (a
 * live source, like a bound socket). An output holds nothing (send is
 * fire-and-forget). Inputs abandoned open at exit are released by the
 * atexit cleanup, so the RC audit stays clean. There is no unref surface
 * — node-midi's Input exposes none.
 *
 * State errors. sendMessage / openPort semantics follow node-midi: an
 * out-of-range port index is a clear thrown Error; openVirtualPort on
 * WinMM throws; opening an already-open handle re-opens (node-midi closes
 * the previous port first — mirrored). */
#include "scr_platform.h"
#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#if !defined(_WIN32)
#include <fcntl.h>
#include <pthread.h>
#include <unistd.h>
#endif

/* ── backend selection (the scr_dgram.c platform-arm stance) ───────────
 * macOS → CoreMIDI, Linux → ALSA sequencer (only when its dev headers are
 * present; this container has none, so the header-less build falls through
 * to the stub and still compiles), Windows → WinMM. Anything else, and a
 * Linux host without libasound-dev, links the STUB: enumeration answers
 * empty, opening a port throws "no MIDI backend", so a non-MIDI platform
 * build stays clean. */
#if defined(_WIN32)
#define SCR_MIDI_WINMM 1
#elif defined(__APPLE__)
#define SCR_MIDI_COREMIDI 1
#elif defined(__linux__) && defined(__has_include)
#if __has_include(<alsa/asoundlib.h>)
#define SCR_MIDI_ALSA 1
#endif
#endif

#if SCR_MIDI_WINMM
#include <windows.h>
#include <mmsystem.h>
#include <winsock2.h> /* the self-pipe socketpair emulation */
#elif SCR_MIDI_COREMIDI
#include <CoreMIDI/CoreMIDI.h>
#include <mach/mach_time.h>
#elif SCR_MIDI_ALSA
#include <alsa/asoundlib.h>
#include <poll.h>
#endif

static void scr_midi_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

/* Monotonic milliseconds — the deltaTime clock. Heap-free and thread-safe
 * (clock_gettime / QueryPerformanceCounter), so an off-thread producer may
 * timestamp its enqueue without touching the runtime. */
static double scr_midi_now_ms(void) {
#if SCR_MIDI_WINMM
  static LARGE_INTEGER freq;
  static bool have_freq = false;
  if (!have_freq) {
    QueryPerformanceFrequency(&freq);
    have_freq = true;
  }
  LARGE_INTEGER c;
  QueryPerformanceCounter(&c);
  return (double)c.QuadPart * 1000.0 / (double)freq.QuadPart;
#else
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6;
#endif
}

/* ── the cross-thread lock (inputs only — producers may be off-thread) ── */
#if SCR_MIDI_WINMM
typedef CRITICAL_SECTION ScrMidiLock;
#define SCR_MIDI_LOCK_INIT(l) InitializeCriticalSection(l)
#define SCR_MIDI_LOCK(l) EnterCriticalSection(l)
#define SCR_MIDI_UNLOCK(l) LeaveCriticalSection(l)
#define SCR_MIDI_LOCK_FINI(l) DeleteCriticalSection(l)
#else
typedef pthread_mutex_t ScrMidiLock;
#define SCR_MIDI_LOCK_INIT(l) pthread_mutex_init((l), NULL)
#define SCR_MIDI_LOCK(l) pthread_mutex_lock(l)
#define SCR_MIDI_UNLOCK(l) pthread_mutex_unlock(l)
#define SCR_MIDI_LOCK_FINI(l) pthread_mutex_destroy(l)
#endif

/* ── the arrival ring (the off-thread hand-off) ───────────────────────
 * A FIFO of raw messages the producer fills under the lock; the loop
 * thread drains it in scr_midi_dispatch. Bytes are plain malloc (libc,
 * not the GC heap), so the realtime producer never allocates a runtime
 * object. */
typedef struct ScrMidiMsg {
  unsigned char *bytes; /* malloc'd */
  size_t len;
  double ts_ms;
  struct ScrMidiMsg *next;
} ScrMidiMsg;

/* ── listener list (the dgram snapshot discipline, restated so this unit
 * links standalone) ─────────────────────────────────────────────────── */
typedef struct {
  ScrClosure *cb;
  void *fn; /* the message adapter thunk (scr_midi_msg_thunk0/1/2) */
  bool once;
} ScrMidiL;

typedef struct {
  ScrMidiL *ls;
  size_t n, cap;
} ScrMidiLs;

static void scr_midi_ls_add(ScrMidiLs *l, ScrClosure *cb, void *fn, bool once) {
  if (l->n == l->cap) {
    l->cap = l->cap ? l->cap * 2 : 2;
    l->ls = realloc(l->ls, l->cap * sizeof *l->ls);
    if (!l->ls) scr_midi_oom();
  }
  l->ls[l->n].cb = cb;
  l->ls[l->n].fn = fn;
  l->ls[l->n].once = once;
  l->n++;
}

static void scr_midi_ls_drop(ScrMidiLs *l) {
  for (size_t i = 0; i < l->n; i++) scr_closure_release(l->ls[i].cb);
  free(l->ls);
  l->ls = NULL;
  l->n = l->cap = 0;
}

/* Snapshot for a firing pass: entries retained; `once` entries leave the
 * LIVE list before their callback runs (the dgram spelling). */
static size_t scr_midi_ls_snapshot(ScrMidiLs *l, ScrMidiL **out) {
  size_t n = l->n;
  if (n == 0) {
    *out = NULL;
    return 0;
  }
  ScrMidiL *snap = malloc(n * sizeof *snap);
  if (!snap) scr_midi_oom();
  for (size_t i = 0; i < n; i++) {
    snap[i] = l->ls[i];
    scr_closure_retain(snap[i].cb);
  }
  size_t w = 0;
  for (size_t i = 0; i < l->n; i++) {
    if (l->ls[i].once) scr_closure_release(l->ls[i].cb);
    else l->ls[w++] = l->ls[i];
  }
  l->n = w;
  *out = snap;
  return n;
}

/* ── the handles ─────────────────────────────────────────────────────── */

typedef enum { SCR_MIDI_IN = 0, SCR_MIDI_OUT = 1 } ScrMidiKind;

struct ScrMidiInput {
  ScrMidiKind kind; /* SCR_MIDI_IN — FIRST member (the void* tag) */
  size_t rc;
  bool open;
  bool is_virtual;
  bool ign_sysex, ign_timing, ign_sense; /* node-midi default: all true */
  bool have_last_ts;
  double last_ts_ms;
  ScrMidiLs msg_ls;
  /* the arrival ring (lock-guarded head/tail; the loop drains it) */
  ScrMidiLock lock;
  ScrMidiMsg *ring_head, *ring_tail;
  bool lock_ready;
  /* registry (open inputs hold the loop) */
  bool in_registry;
  struct ScrMidiInput *next;
  /* platform state */
#if SCR_MIDI_ALSA
  snd_seq_t *seq;
  int seq_port;
  int seq_dest_client, seq_dest_port; /* the connected source (openPort) */
  snd_midi_event_t *decoder;
  int *pfds;      /* registered poll fds, forgotten before close */
  int npfds;
#elif SCR_MIDI_COREMIDI
  MIDIClientRef client;
  MIDIPortRef port;         /* the input port (openPort) */
  MIDIEndpointRef endpoint; /* the connected source, or the virtual dest */
  int pipe_r, pipe_w;       /* self-pipe: producer pokes, poller watches r */
#elif SCR_MIDI_WINMM
  HMIDIIN h;
  int pipe_r, pipe_w;
  char sysex_buf[1024];
  MIDIHDR sysex_hdr;
#endif
};

struct ScrMidiOutput {
  ScrMidiKind kind; /* SCR_MIDI_OUT — FIRST member (the void* tag) */
  size_t rc;
  bool open;
  bool is_virtual;
#if SCR_MIDI_ALSA
  snd_seq_t *seq;
  int seq_port;
  int seq_dest_client, seq_dest_port;
  snd_midi_event_t *encoder;
#elif SCR_MIDI_COREMIDI
  MIDIClientRef client;
  MIDIPortRef port;         /* the output port (openPort) */
  MIDIEndpointRef endpoint; /* the connected destination, or virtual source */
  bool endpoint_is_virtual;
#elif SCR_MIDI_WINMM
  HMIDIOUT h;
#endif
};

#ifdef SCR_RC_AUDIT
static long scr_midi_live = 0;
long scr_midi_live_count(void) { return scr_midi_live; }
#endif

static ScrMidiInput *scr_midi_inputs = NULL; /* registry: +1 each */
static ScrPoller *scr_midi_poller = NULL;

/* ── poller plumbing (the scr_platform.h seam) ───────────────────────── */

static bool scr_midi_poller_init(void) {
  if (scr_midi_poller != NULL) return true;
  scr_midi_poller = scrp_poller_new();
  return scr_midi_poller != NULL;
}

static void scr_midi_watch_read(int fd, void *udata, bool on) {
  if (scr_midi_poller == NULL || fd < 0) return;
  (void)scrp_watch_read(scr_midi_poller, fd, udata, on);
}

/* Forget-then-close — the epoll obligation (scr_platform.h); a no-op
 * forget on the kqueue side keeps macOS byte-identical. */
static void scr_midi_forget_fd(int fd) {
  if (fd < 0) return;
  if (scr_midi_poller != NULL) scrp_forget(scr_midi_poller, fd);
}

/* ── registry ────────────────────────────────────────────────────────── */

ScrMidiInput *scr_midi_input_retain(ScrMidiInput *s) {
  if (s->rc != SIZE_MAX) s->rc++;
  return s;
}
void scr_midi_input_release(ScrMidiInput *s); /* fwd */

static void scr_midi_register(ScrMidiInput *s) {
  if (s->in_registry) return;
  s->in_registry = true;
  s->next = NULL;
  ScrMidiInput **link = &scr_midi_inputs;
  while (*link) link = &(*link)->next;
  *link = scr_midi_input_retain(s);
}

static void scr_midi_unregister(ScrMidiInput *s) {
  if (!s->in_registry) return;
  ScrMidiInput **link = &scr_midi_inputs;
  while (*link && *link != s) link = &(*link)->next;
  if (*link) {
    *link = s->next;
    s->next = NULL;
    s->in_registry = false;
    scr_midi_input_release(s);
  }
}

/* ── the arrival ring ────────────────────────────────────────────────── */

/* Producer side (may be OFF-THREAD on CoreMIDI/WinMM): copy the bytes and
 * link them under the lock. NEVER touches the runtime heap — libc malloc
 * only. Returns true if a poller poke is warranted (pipe backends write
 * one byte after this). */
static void scr_midi_ring_push(ScrMidiInput *s, const unsigned char *bytes, size_t len,
                                double ts_ms) {
  if (len == 0) return;
  ScrMidiMsg *m = malloc(sizeof *m);
  if (!m) return; /* drop on exhaustion, like a full kernel MIDI queue */
  m->bytes = malloc(len);
  if (!m->bytes) {
    free(m);
    return;
  }
  memcpy(m->bytes, bytes, len);
  m->len = len;
  m->ts_ms = ts_ms;
  m->next = NULL;
  SCR_MIDI_LOCK(&s->lock);
  if (s->ring_tail) s->ring_tail->next = m;
  else s->ring_head = m;
  s->ring_tail = m;
  SCR_MIDI_UNLOCK(&s->lock);
}

/* Consumer side (LOOP THREAD only): pop one message, ownership to caller. */
static ScrMidiMsg *scr_midi_ring_pop(ScrMidiInput *s) {
  SCR_MIDI_LOCK(&s->lock);
  ScrMidiMsg *m = s->ring_head;
  if (m) {
    s->ring_head = m->next;
    if (!s->ring_head) s->ring_tail = NULL;
  }
  SCR_MIDI_UNLOCK(&s->lock);
  return m;
}

static bool scr_midi_ring_nonempty(ScrMidiInput *s) {
  SCR_MIDI_LOCK(&s->lock);
  bool has = s->ring_head != NULL;
  SCR_MIDI_UNLOCK(&s->lock);
  return has;
}

static void scr_midi_ring_clear(ScrMidiInput *s) {
  ScrMidiMsg *m;
  while ((m = scr_midi_ring_pop(s)) != NULL) {
    free(m->bytes);
    free(m);
  }
}

/* The ignoreTypes filter (RtMidi's status-byte test), applied on the loop
 * thread so the realtime producer stays branch-free. */
static bool scr_midi_filtered(const ScrMidiInput *s, const unsigned char *b, size_t len) {
  if (len == 0) return true;
  unsigned char st = b[0];
  if (s->ign_sysex && st == 0xF0) return true;
  if (s->ign_timing && (st == 0xF8 || st == 0xF1)) return true;
  if (s->ign_sense && st == 0xFE) return true;
  return false;
}

/* ── the message adapters (the dgram thunk family) ───────────────────── */

/* The adapter signature: deltaTime as the leading f64, the byte run as a
 * number[] (SCR_ELEM_F64). BORROWED to the adapter (multiple listeners see
 * one message); the two-param adapter retains for its listener's owned
 * param, per the universal convention. */
void scr_midi_msg_thunk0(ScrClosure *cb, double dt, ScrArr *msg) {
  (void)dt;
  (void)msg;
  ((void (*)(ScrClosure *))cb->fn)(cb);
}
void scr_midi_msg_thunk1(ScrClosure *cb, double dt, ScrArr *msg) {
  (void)msg;
  ((void (*)(ScrClosure *, double))cb->fn)(cb, dt);
}
void scr_midi_msg_thunk2(ScrClosure *cb, double dt, ScrArr *msg) {
  ((void (*)(ScrClosure *, double, ScrArr *))cb->fn)(cb, dt, scr_arr_retain(msg));
}

/* ── platform backend forward declarations ───────────────────────────── */

static int scr_midi_plat_count(bool is_input);
static bool scr_midi_plat_name(bool is_input, int idx, char *buf, size_t bufsz);
static const char *scr_midi_plat_in_open(ScrMidiInput *s, int idx, const char *vname);
static void scr_midi_plat_in_close(ScrMidiInput *s);
static void scr_midi_plat_in_pump(ScrMidiInput *s); /* drain the source into the ring */
static const char *scr_midi_plat_out_open(ScrMidiOutput *s, int idx, const char *vname);
static void scr_midi_plat_out_close(ScrMidiOutput *s);
static void scr_midi_plat_out_send(ScrMidiOutput *s, const unsigned char *bytes, size_t len);

/* ── RC ──────────────────────────────────────────────────────────────── */

void scr_midi_input_release(ScrMidiInput *s) {
  if (!s || s->rc == SIZE_MAX) return;
  if (--s->rc == 0) {
    if (s->open) scr_midi_plat_in_close(s);
    scr_midi_ls_drop(&s->msg_ls);
    scr_midi_ring_clear(s);
    if (s->lock_ready) SCR_MIDI_LOCK_FINI(&s->lock);
#ifdef SCR_RC_AUDIT
    scr_midi_live--;
#endif
    free(s);
  }
}

ScrMidiOutput *scr_midi_output_retain(ScrMidiOutput *s) {
  if (s->rc != SIZE_MAX) s->rc++;
  return s;
}

void scr_midi_output_release(ScrMidiOutput *s) {
  if (!s || s->rc == SIZE_MAX) return;
  if (--s->rc == 0) {
    if (s->open) scr_midi_plat_out_close(s);
#ifdef SCR_RC_AUDIT
    scr_midi_live--;
#endif
    free(s);
  }
}

/* The void* RC entry points the compiler stores per handle kind. */
void *scr_midi_input_retain_v(void *p) { return scr_midi_input_retain((ScrMidiInput *)p); }
void scr_midi_input_release_v(void *p) { scr_midi_input_release((ScrMidiInput *)p); }
void *scr_midi_output_retain_v(void *p) { return scr_midi_output_retain((ScrMidiOutput *)p); }
void scr_midi_output_release_v(void *p) { scr_midi_output_release((ScrMidiOutput *)p); }

/* ── the surface: construction ───────────────────────────────────────── */

ScrMidiInput *scr_midi_input_new(void) {
  ScrMidiInput *s = calloc(1, sizeof *s);
  if (!s) scr_midi_oom();
  s->kind = SCR_MIDI_IN;
  s->rc = 1;
  s->ign_sysex = s->ign_timing = s->ign_sense = true; /* node-midi default */
  SCR_MIDI_LOCK_INIT(&s->lock);
  s->lock_ready = true;
#if SCR_MIDI_COREMIDI || SCR_MIDI_WINMM
  s->pipe_r = s->pipe_w = -1;
#endif
#ifdef SCR_RC_AUDIT
  scr_midi_live++;
#endif
  return s;
}

ScrMidiOutput *scr_midi_output_new(void) {
  ScrMidiOutput *s = calloc(1, sizeof *s);
  if (!s) scr_midi_oom();
  s->kind = SCR_MIDI_OUT;
  s->rc = 1;
#ifdef SCR_RC_AUDIT
  scr_midi_live++;
#endif
  return s;
}

static void scr_midi_throw(const char *msg) {
  scr_throw_error_msg(0 /* Error */, msg, strlen(msg));
}

/* getPortCount / getPortName work on a fresh handle before openPort
 * (node-midi enumerates then opens — §7's confirmed stance). isInput
 * selects the input vs output port namespace; the frozen ABI passes it
 * explicitly so the shared symbol needs no per-handle read. */
double scr_midi_port_count(void *handle, bool is_input) {
  (void)handle;
  int n = scr_midi_plat_count(is_input);
  return n < 0 ? 0 : (double)n;
}

ScrStr *scr_midi_port_name(void *handle, double idx) {
  ScrMidiKind kind = *(ScrMidiKind *)handle;
  char buf[256];
  if (!scr_midi_plat_name(kind == SCR_MIDI_IN, (int)idx, buf, sizeof buf)) {
    /* node-midi returns "" for an out-of-range index rather than throwing. */
    return scr_str_new("", 0);
  }
  return scr_str_new(buf, strlen(buf));
}

/* ── open / close ────────────────────────────────────────────────────── */

void scr_midi_open_port(void *handle, double idx) {
  if (!scr_midi_poller_init()) {
    fputs("scriptc: event poller init failed\n", stderr);
    abort();
  }
  ScrMidiKind kind = *(ScrMidiKind *)handle;
  if (kind == SCR_MIDI_IN) {
    ScrMidiInput *s = (ScrMidiInput *)handle;
    if (s->open) scr_midi_plat_in_close(s); /* node-midi re-opens */
    const char *err = scr_midi_plat_in_open(s, (int)idx, NULL);
    if (err) {
      scr_midi_throw(err);
      return;
    }
    s->open = true;
    s->is_virtual = false;
    s->have_last_ts = false;
    scr_midi_register(s); /* an open input holds the loop */
  } else {
    ScrMidiOutput *s = (ScrMidiOutput *)handle;
    if (s->open) scr_midi_plat_out_close(s);
    const char *err = scr_midi_plat_out_open(s, (int)idx, NULL);
    if (err) {
      scr_midi_throw(err);
      return;
    }
    s->open = true;
    s->is_virtual = false;
  }
}

void scr_midi_open_virtual(void *handle, ScrStr *name) {
  if (!scr_midi_poller_init()) {
    fputs("scriptc: event poller init failed\n", stderr);
    abort();
  }
  const char *vname = name && name->len ? name->data : "scriptc";
  ScrMidiKind kind = *(ScrMidiKind *)handle;
  if (kind == SCR_MIDI_IN) {
    ScrMidiInput *s = (ScrMidiInput *)handle;
    if (s->open) scr_midi_plat_in_close(s);
    const char *err = scr_midi_plat_in_open(s, -1, vname);
    if (err) {
      scr_midi_throw(err);
      return;
    }
    s->open = true;
    s->is_virtual = true;
    s->have_last_ts = false;
    scr_midi_register(s);
  } else {
    ScrMidiOutput *s = (ScrMidiOutput *)handle;
    if (s->open) scr_midi_plat_out_close(s);
    const char *err = scr_midi_plat_out_open(s, -1, vname);
    if (err) {
      scr_midi_throw(err);
      return;
    }
    s->open = true;
    s->is_virtual = true;
  }
}

void scr_midi_close_port(void *handle) {
  ScrMidiKind kind = *(ScrMidiKind *)handle;
  if (kind == SCR_MIDI_IN) {
    ScrMidiInput *s = (ScrMidiInput *)handle;
    if (!s->open) return; /* node-midi tolerates close on a closed port */
    scr_midi_plat_in_close(s); /* forgets its fds, then closes them */
    s->open = false;
    scr_midi_ring_clear(s);
    scr_midi_unregister(s); /* the loop can drain */
  } else {
    ScrMidiOutput *s = (ScrMidiOutput *)handle;
    if (!s->open) return;
    scr_midi_plat_out_close(s);
    s->open = false;
  }
}

bool scr_midi_is_open(void *handle) {
  ScrMidiKind kind = *(ScrMidiKind *)handle;
  if (kind == SCR_MIDI_IN) return ((ScrMidiInput *)handle)->open;
  return ((ScrMidiOutput *)handle)->open;
}

void scr_midi_ignore_types(ScrMidiInput *s, bool sysex, bool timing, bool sense) {
  s->ign_sysex = sysex;
  s->ign_timing = timing;
  s->ign_sense = sense;
}

/* ── send ────────────────────────────────────────────────────────────── */

/* The ABI primitive (the frozen table's `midi.send`): raw bytes + length. */
void scr_midi_send(ScrMidiOutput *s, const uint8_t *bytes, double len) {
  if (!s->open) {
    scr_midi_throw("Message sent on unopened port");
    return;
  }
  size_t n = len < 0 ? 0 : (size_t)len;
  if (n == 0) return;
  scr_midi_plat_out_send(s, bytes, n);
}

/* Marshaling entry points for the two accepted argument shapes (the
 * surfaces.ts stance: a number[] literal/variable, or a Uint8Array). Both
 * narrow to the raw primitive above. */
void scr_midi_send_array(ScrMidiOutput *s, ScrArr *message) {
  size_t n = (size_t)message->len;
  if (n == 0) {
    if (!s->open) scr_midi_throw("Message sent on unopened port");
    return;
  }
  unsigned char stackbuf[64];
  unsigned char *buf = n <= sizeof stackbuf ? stackbuf : malloc(n);
  if (!buf) scr_midi_oom();
  for (size_t i = 0; i < n; i++) {
    double v = scr_arr_get_f64(message, (double)i);
    buf[i] = (unsigned char)((int)v & 0xFF);
  }
  scr_midi_send(s, buf, (double)n);
  if (buf != stackbuf) free(buf);
}

void scr_midi_send_bytes(ScrMidiOutput *s, ScrBytes *message) {
  size_t n = (size_t)scr_bytes_byte_len(message);
  scr_midi_send(s, (const uint8_t *)message->data, (double)n);
}

/* ── on('message') / once('message') ─────────────────────────────────── */

void scr_midi_on_message(ScrMidiInput *s, ScrClosure *cb, ScrMidiMsgFn fn, bool once) {
  if (!s) {
    scr_closure_release(cb);
    return;
  }
  scr_midi_ls_add(&s->msg_ls, cb, (void *)fn, once);
}

/* ── the fire path (LOOP THREAD) ─────────────────────────────────────── */

/* Drain one input's ring, firing 'message' for each un-filtered message.
 * The number[] is built here (never off-thread); deltaTime is seconds
 * since the previous DELIVERED message, 0 for the first. The handle is
 * retained across the drain (a listener may closePort/release it). */
static void scr_midi_in_fire(ScrMidiInput *s) {
  scr_midi_input_retain(s);
  for (;;) {
    ScrMidiMsg *m = scr_midi_ring_pop(s);
    if (!m) break;
    if (scr_midi_filtered(s, m->bytes, m->len)) {
      free(m->bytes);
      free(m);
      continue;
    }
    double dt = 0.0;
    if (s->have_last_ts) dt = (m->ts_ms - s->last_ts_ms) / 1000.0;
    s->last_ts_ms = m->ts_ms;
    s->have_last_ts = true;

    ScrArr *arr = scr_arr_new(SCR_ELEM_F64, m->len);
    for (size_t i = 0; i < m->len; i++) scr_arr_push_f64(arr, (double)m->bytes[i]);
    free(m->bytes);
    free(m);

    ScrMidiL *snap;
    size_t nl = scr_midi_ls_snapshot(&s->msg_ls, &snap);
    for (size_t i = 0; i < nl; i++) {
      if (!scr_exc_pending()) ((ScrMidiMsgFn)snap[i].fn)(snap[i].cb, dt, arr);
      scr_closure_release(snap[i].cb);
    }
    free(snap);
    scr_arr_release(arr);
    if (scr_exc_pending()) break;
  }
  scr_midi_input_release(s);
}

/* ── the loop hooks (scr_async.c) ────────────────────────────────────── */

static bool scr_midi_pending(void) {
  for (ScrMidiInput *s = scr_midi_inputs; s; s = s->next) {
    /* An open input holds the loop (a live source); a filled ring is due
     * work regardless. */
    if (s->open) return true;
    if (scr_midi_ring_nonempty(s)) return true;
  }
  return false;
}

static int scr_midi_pollfd(void) {
  return scr_midi_poller != NULL ? scrp_poller_fd(scr_midi_poller) : -1;
}

/* Called each loop turn (the dgram dispatch station's exact shape):
 * alternate a zero-timeout poller drain — which pumps each ready input's
 * platform source into its ring (ALSA decode on the loop thread; a pipe
 * drain for the off-thread backends, whose bytes are already in the ring)
 * — with a firing pass, stopping when a listener enqueued microtasks or
 * threw. */
static void scr_midi_dispatch(void) {
  if (!scr_midi_inputs) return;
  for (;;) {
    if (scr_midi_poller != NULL) {
      ScrPollerEvent evs[64];
      int n = scrp_drain(scr_midi_poller, evs, 64);
      for (int i = 0; i < n; i++) {
        ScrMidiInput *s = (ScrMidiInput *)evs[i].udata;
        if (!s || !s->open) continue; /* closed earlier in this batch */
        scr_midi_plat_in_pump(s);
      }
    }
    bool any = false;
    for (ScrMidiInput *s = scr_midi_inputs; s; s = s->next) {
      if (!scr_midi_ring_nonempty(s)) continue;
      any = true;
      scr_midi_in_fire(s);
      if (scr_exc_pending()) return;
    }
    if (!any) return;
    if (scr_loop_has_ready()) return; /* microtasks interleave first */
  }
}

/* Exit-time cleanup (the dgram precedent): inputs a program leaves open at
 * exit release their listeners and registry references so the RC audit
 * sees a clean heap. */
static void scr_midi_cleanup_atexit(void) {
  while (scr_midi_inputs) {
    ScrMidiInput *s = scr_midi_inputs;
    if (s->open) {
      scr_midi_plat_in_close(s);
      s->open = false;
    }
    scr_midi_ls_drop(&s->msg_ls);
    scr_midi_ring_clear(s);
    scr_midi_unregister(s);
  }
}

void scr_midi_install(void) {
  static bool installed = false;
  if (installed) return;
  installed = true;
  atexit(scr_midi_cleanup_atexit);
  scr_loop_set_midi(&scr_midi_pending, &scr_midi_dispatch, &scr_midi_pollfd);
}

/* ══ platform backends ═══════════════════════════════════════════════════
 * Each provides: enumerate (count/name), open input/output (idx>=0 opens a
 * real port; idx<0 opens a virtual port named vname), close, pump (drain a
 * source into the ring), send. All error strings are returned (NULL =
 * success) so the portable surface owns the throw. */

/* ─────────────────────────── Linux: ALSA sequencer ─────────────────── */
#if SCR_MIDI_ALSA

/* A shared client handle for pure ENUMERATION (getPortCount/getPortName on
 * a fresh handle, before any port opens). Opened lazily, kept for the
 * process; the per-handle open uses its own client. */
static snd_seq_t *scr_midi_enum_seq(void) {
  static snd_seq_t *seq = NULL;
  if (seq == NULL) {
    if (snd_seq_open(&seq, "default", SND_SEQ_OPEN_DUPLEX, 0) < 0) seq = NULL;
  }
  return seq;
}

/* Walk every client/port, invoking `hit` for each whose capability matches
 * the direction we want (input source = readable+subscribable-read; output
 * sink = writable+subscribable-write). Returns the total, and fills
 * client/port + name for the `want`-th match when name!=NULL. */
static int scr_midi_alsa_walk(bool is_input, int want, int *out_client, int *out_port,
                               char *name, size_t namesz) {
  snd_seq_t *seq = scr_midi_enum_seq();
  if (!seq) return -1;
  unsigned int need = is_input ? (SND_SEQ_PORT_CAP_READ | SND_SEQ_PORT_CAP_SUBS_READ)
                               : (SND_SEQ_PORT_CAP_WRITE | SND_SEQ_PORT_CAP_SUBS_WRITE);
  snd_seq_client_info_t *cinfo;
  snd_seq_port_info_t *pinfo;
  snd_seq_client_info_alloca(&cinfo);
  snd_seq_port_info_alloca(&pinfo);
  snd_seq_client_info_set_client(cinfo, -1);
  int count = 0;
  while (snd_seq_query_next_client(seq, cinfo) >= 0) {
    int client = snd_seq_client_info_get_client(cinfo);
    if (client == SND_SEQ_CLIENT_SYSTEM) continue; /* skip the system client */
    snd_seq_port_info_set_client(pinfo, client);
    snd_seq_port_info_set_port(pinfo, -1);
    while (snd_seq_query_next_port(seq, pinfo) >= 0) {
      unsigned int caps = snd_seq_port_info_get_capability(pinfo);
      if ((caps & need) != need) continue;
      if (want == count) {
        if (out_client) *out_client = client;
        if (out_port) *out_port = snd_seq_port_info_get_port(pinfo);
        if (name && namesz) {
          snprintf(name, namesz, "%s:%d", snd_seq_client_info_get_name(cinfo),
                   snd_seq_port_info_get_port(pinfo));
        }
      }
      count++;
    }
  }
  return count;
}

static int scr_midi_plat_count(bool is_input) {
  return scr_midi_alsa_walk(is_input, -1, NULL, NULL, NULL, 0);
}

static bool scr_midi_plat_name(bool is_input, int idx, char *buf, size_t bufsz) {
  int c = -1, p = -1;
  char nm[256] = "";
  int total = scr_midi_alsa_walk(is_input, idx, &c, &p, nm, sizeof nm);
  if (idx < 0 || idx >= total || nm[0] == '\0') return false;
  snprintf(buf, bufsz, "%s", nm);
  return true;
}

static const char *scr_midi_plat_in_open(ScrMidiInput *s, int idx, const char *vname) {
  if (snd_seq_open(&s->seq, "default", SND_SEQ_OPEN_DUPLEX, SND_SEQ_NONBLOCK) < 0)
    return "MIDI: could not open ALSA sequencer";
  snd_seq_set_client_name(s->seq, vname ? vname : "scriptc-input");
  /* Our port is WRITABLE (others write to us) so it can receive. */
  s->seq_port = snd_seq_create_simple_port(
      s->seq, vname ? vname : "scriptc-input",
      SND_SEQ_PORT_CAP_WRITE | SND_SEQ_PORT_CAP_SUBS_WRITE,
      SND_SEQ_PORT_TYPE_MIDI_GENERIC | SND_SEQ_PORT_TYPE_APPLICATION);
  if (s->seq_port < 0) {
    snd_seq_close(s->seq);
    s->seq = NULL;
    return "MIDI: could not create ALSA port";
  }
  if (snd_midi_event_new(1024, &s->decoder) < 0) {
    snd_seq_delete_simple_port(s->seq, s->seq_port);
    snd_seq_close(s->seq);
    s->seq = NULL;
    return "MIDI: could not create event decoder";
  }
  snd_midi_event_no_status(s->decoder, 1); /* emit full status each message */
  if (idx >= 0) {
    int c = -1, p = -1;
    int total = scr_midi_alsa_walk(true, idx, &c, &p, NULL, 0);
    if (idx >= total) {
      scr_midi_plat_in_close(s);
      return "MIDI: port index out of range";
    }
    s->seq_dest_client = c;
    s->seq_dest_port = p;
    /* Subscribe: connect the remote source to our writable port. */
    if (snd_seq_connect_from(s->seq, s->seq_port, c, p) < 0) {
      scr_midi_plat_in_close(s);
      return "MIDI: could not connect to input port";
    }
  }
  /* Register the sequencer's pollable fds with the loop poller. */
  int npfd = snd_seq_poll_descriptors_count(s->seq, POLLIN);
  if (npfd > 0) {
    struct pollfd *pfd = calloc((size_t)npfd, sizeof *pfd);
    if (!pfd) scr_midi_oom();
    npfd = snd_seq_poll_descriptors(s->seq, pfd, (unsigned)npfd, POLLIN);
    s->pfds = calloc((size_t)npfd, sizeof(int));
    if (!s->pfds) scr_midi_oom();
    s->npfds = npfd;
    for (int i = 0; i < npfd; i++) {
      s->pfds[i] = pfd[i].fd;
      scr_midi_watch_read(pfd[i].fd, s, true);
    }
    free(pfd);
  }
  return NULL;
}

static void scr_midi_plat_in_close(ScrMidiInput *s) {
  for (int i = 0; i < s->npfds; i++) scr_midi_forget_fd(s->pfds[i]);
  free(s->pfds);
  s->pfds = NULL;
  s->npfds = 0;
  if (s->decoder) {
    snd_midi_event_free(s->decoder);
    s->decoder = NULL;
  }
  if (s->seq) {
    if (s->seq_port >= 0) snd_seq_delete_simple_port(s->seq, s->seq_port);
    snd_seq_close(s->seq);
    s->seq = NULL;
    s->seq_port = -1;
  }
}

static void scr_midi_plat_in_pump(ScrMidiInput *s) {
  if (!s->seq || !s->decoder) return;
  snd_seq_event_t *ev = NULL;
  while (snd_seq_event_input(s->seq, &ev) >= 0 && ev != NULL) {
    unsigned char buf[1024];
    long n = snd_midi_event_decode(s->decoder, buf, sizeof buf, ev);
    if (n > 0) scr_midi_ring_push(s, buf, (size_t)n, scr_midi_now_ms());
    /* snd_seq_event_input returns >0 while more input is buffered; the
     * loop exits when it returns -EAGAIN (no more pending). */
  }
}

static const char *scr_midi_plat_out_open(ScrMidiOutput *s, int idx, const char *vname) {
  if (snd_seq_open(&s->seq, "default", SND_SEQ_OPEN_DUPLEX, 0) < 0)
    return "MIDI: could not open ALSA sequencer";
  snd_seq_set_client_name(s->seq, vname ? vname : "scriptc-output");
  /* Our port is READABLE (others read from us) so it can transmit. */
  s->seq_port = snd_seq_create_simple_port(
      s->seq, vname ? vname : "scriptc-output",
      SND_SEQ_PORT_CAP_READ | SND_SEQ_PORT_CAP_SUBS_READ,
      SND_SEQ_PORT_TYPE_MIDI_GENERIC | SND_SEQ_PORT_TYPE_APPLICATION);
  if (s->seq_port < 0) {
    snd_seq_close(s->seq);
    s->seq = NULL;
    return "MIDI: could not create ALSA port";
  }
  if (snd_midi_event_new(1024, &s->encoder) < 0) {
    snd_seq_delete_simple_port(s->seq, s->seq_port);
    snd_seq_close(s->seq);
    s->seq = NULL;
    return "MIDI: could not create event encoder";
  }
  snd_midi_event_init(s->encoder);
  if (idx >= 0) {
    int c = -1, p = -1;
    int total = scr_midi_alsa_walk(false, idx, &c, &p, NULL, 0);
    if (idx >= total) {
      scr_midi_plat_out_close(s);
      return "MIDI: port index out of range";
    }
    s->seq_dest_client = c;
    s->seq_dest_port = p;
    if (snd_seq_connect_to(s->seq, s->seq_port, c, p) < 0) {
      scr_midi_plat_out_close(s);
      return "MIDI: could not connect to output port";
    }
  }
  return NULL;
}

static void scr_midi_plat_out_close(ScrMidiOutput *s) {
  if (s->encoder) {
    snd_midi_event_free(s->encoder);
    s->encoder = NULL;
  }
  if (s->seq) {
    if (s->seq_port >= 0) snd_seq_delete_simple_port(s->seq, s->seq_port);
    snd_seq_close(s->seq);
    s->seq = NULL;
    s->seq_port = -1;
  }
}

static void scr_midi_plat_out_send(ScrMidiOutput *s, const unsigned char *bytes, size_t len) {
  if (!s->seq || !s->encoder) return;
  snd_seq_event_t ev;
  size_t off = 0;
  while (off < len) {
    snd_seq_ev_clear(&ev);
    long used = snd_midi_event_encode(s->encoder, bytes + off, (long)(len - off), &ev);
    if (used <= 0) break;
    off += (size_t)used;
    if (ev.type == SND_SEQ_EVENT_NONE) continue; /* mid-message, no event yet */
    snd_seq_ev_set_source(&ev, s->seq_port);
    snd_seq_ev_set_subs(&ev);
    snd_seq_ev_set_direct(&ev);
    snd_seq_event_output(s->seq, &ev);
  }
  snd_seq_drain_output(s->seq);
}

/* ─────────────────────────── macOS: CoreMIDI ───────────────────────── */
#elif SCR_MIDI_COREMIDI

static int scr_midi_plat_count(bool is_input) {
  return (int)(is_input ? MIDIGetNumberOfSources() : MIDIGetNumberOfDestinations());
}

static bool scr_midi_cm_name(MIDIEndpointRef ep, char *buf, size_t bufsz) {
  if (ep == 0) return false;
  CFStringRef cf = NULL;
  if (MIDIObjectGetStringProperty(ep, kMIDIPropertyDisplayName, &cf) != noErr || !cf)
    return false;
  Boolean ok = CFStringGetCString(cf, buf, (CFIndex)bufsz, kCFStringEncodingUTF8);
  CFRelease(cf);
  return ok ? true : false;
}

static bool scr_midi_plat_name(bool is_input, int idx, char *buf, size_t bufsz) {
  ItemCount total = is_input ? MIDIGetNumberOfSources() : MIDIGetNumberOfDestinations();
  if (idx < 0 || (ItemCount)idx >= total) return false;
  MIDIEndpointRef ep =
      is_input ? MIDIGetSource((ItemCount)idx) : MIDIGetDestination((ItemCount)idx);
  return scr_midi_cm_name(ep, buf, bufsz);
}

/* The CoreMIDI read callback — RUNS ON A COREMIDI THREAD. It must not
 * touch the runtime: it only copies bytes into the ring (libc malloc) and
 * pokes the self-pipe. */
static void scr_midi_cm_read(const MIDIPacketList *pktlist, void *readProcRefCon,
                             void *srcConnRefCon) {
  (void)srcConnRefCon;
  ScrMidiInput *s = (ScrMidiInput *)readProcRefCon;
  const MIDIPacket *pkt = &pktlist->packet[0];
  double now = scr_midi_now_ms();
  for (UInt32 i = 0; i < pktlist->numPackets; i++) {
    scr_midi_ring_push(s, pkt->data, pkt->length, now);
    pkt = MIDIPacketNext(pkt);
  }
  if (s->pipe_w >= 0) {
    unsigned char one = 1;
    ssize_t w = write(s->pipe_w, &one, 1); /* wake the loop */
    (void)w;
  }
}

static const char *scr_midi_cm_selfpipe(ScrMidiInput *s) {
  int fds[2];
  if (pipe(fds) != 0) return "MIDI: could not create wake pipe";
  fcntl(fds[0], F_SETFL, O_NONBLOCK);
  fcntl(fds[0], F_SETFD, FD_CLOEXEC);
  fcntl(fds[1], F_SETFD, FD_CLOEXEC);
  s->pipe_r = fds[0];
  s->pipe_w = fds[1];
  scr_midi_watch_read(s->pipe_r, s, true);
  return NULL;
}

static const char *scr_midi_plat_in_open(ScrMidiInput *s, int idx, const char *vname) {
  if (MIDIClientCreate(CFSTR("scriptc"), NULL, NULL, &s->client) != noErr)
    return "MIDI: could not create CoreMIDI client";
  const char *pipe_err = scr_midi_cm_selfpipe(s);
  if (pipe_err) {
    MIDIClientDispose(s->client);
    s->client = 0;
    return pipe_err;
  }
  if (idx >= 0) {
    if (MIDIInputPortCreate(s->client, CFSTR("scriptc-in"), scr_midi_cm_read, s, &s->port) !=
        noErr) {
      scr_midi_plat_in_close(s);
      return "MIDI: could not create input port";
    }
    ItemCount total = MIDIGetNumberOfSources();
    if ((ItemCount)idx >= total) {
      scr_midi_plat_in_close(s);
      return "MIDI: port index out of range";
    }
    s->endpoint = MIDIGetSource((ItemCount)idx);
    if (MIDIPortConnectSource(s->port, s->endpoint, s) != noErr) {
      scr_midi_plat_in_close(s);
      return "MIDI: could not connect to input port";
    }
  } else {
    /* A virtual input is a DESTINATION we publish for others to send to. */
    CFStringRef nm = CFStringCreateWithCString(NULL, vname, kCFStringEncodingUTF8);
    OSStatus rc =
        MIDIDestinationCreate(s->client, nm, scr_midi_cm_read, s, &s->endpoint);
    if (nm) CFRelease(nm);
    if (rc != noErr) {
      scr_midi_plat_in_close(s);
      return "MIDI: could not create virtual input port";
    }
  }
  return NULL;
}

static void scr_midi_plat_in_close(ScrMidiInput *s) {
  if (s->port && s->endpoint) MIDIPortDisconnectSource(s->port, s->endpoint);
  if (s->is_virtual && s->endpoint) MIDIEndpointDispose(s->endpoint);
  s->endpoint = 0;
  if (s->port) {
    MIDIPortDispose(s->port);
    s->port = 0;
  }
  if (s->client) {
    MIDIClientDispose(s->client);
    s->client = 0;
  }
  if (s->pipe_r >= 0) {
    scr_midi_forget_fd(s->pipe_r);
    close(s->pipe_r);
    s->pipe_r = -1;
  }
  if (s->pipe_w >= 0) {
    close(s->pipe_w);
    s->pipe_w = -1;
  }
}

/* Loop-thread pump: the bytes are already in the ring (the read callback
 * put them there); just drain the wake pipe so it stops signalling. */
static void scr_midi_plat_in_pump(ScrMidiInput *s) {
  if (s->pipe_r < 0) return;
  unsigned char buf[256];
  while (read(s->pipe_r, buf, sizeof buf) > 0) { /* drain */
  }
}

static const char *scr_midi_plat_out_open(ScrMidiOutput *s, int idx, const char *vname) {
  if (MIDIClientCreate(CFSTR("scriptc"), NULL, NULL, &s->client) != noErr)
    return "MIDI: could not create CoreMIDI client";
  if (idx >= 0) {
    if (MIDIOutputPortCreate(s->client, CFSTR("scriptc-out"), &s->port) != noErr) {
      scr_midi_plat_out_close(s);
      return "MIDI: could not create output port";
    }
    ItemCount total = MIDIGetNumberOfDestinations();
    if ((ItemCount)idx >= total) {
      scr_midi_plat_out_close(s);
      return "MIDI: port index out of range";
    }
    s->endpoint = MIDIGetDestination((ItemCount)idx);
    s->endpoint_is_virtual = false;
  } else {
    /* A virtual output is a SOURCE we publish for others to read from. */
    CFStringRef nm = CFStringCreateWithCString(NULL, vname, kCFStringEncodingUTF8);
    OSStatus rc = MIDISourceCreate(s->client, nm, &s->endpoint);
    if (nm) CFRelease(nm);
    if (rc != noErr) {
      scr_midi_plat_out_close(s);
      return "MIDI: could not create virtual output port";
    }
    s->endpoint_is_virtual = true;
  }
  return NULL;
}

static void scr_midi_plat_out_close(ScrMidiOutput *s) {
  if (s->endpoint_is_virtual && s->endpoint) MIDIEndpointDispose(s->endpoint);
  s->endpoint = 0;
  if (s->port) {
    MIDIPortDispose(s->port);
    s->port = 0;
  }
  if (s->client) {
    MIDIClientDispose(s->client);
    s->client = 0;
  }
}

static void scr_midi_plat_out_send(ScrMidiOutput *s, const unsigned char *bytes, size_t len) {
  Byte storage[512 + sizeof(MIDIPacketList)];
  MIDIPacketList *pl;
  Byte *heap = NULL;
  if (len + sizeof(MIDIPacketList) + 16 > sizeof storage) {
    heap = malloc(len + sizeof(MIDIPacketList) + 16);
    if (!heap) scr_midi_oom();
    pl = (MIDIPacketList *)heap;
  } else {
    pl = (MIDIPacketList *)storage;
  }
  MIDIPacket *pkt = MIDIPacketListInit(pl);
  pkt = MIDIPacketListAdd(
      pl, len + sizeof(MIDIPacketList) + 16, pkt, mach_absolute_time(), len, bytes);
  if (pkt) {
    if (s->endpoint_is_virtual) MIDIReceived(s->endpoint, pl); /* publish on the source */
    else MIDISend(s->port, s->endpoint, pl);
  }
  free(heap);
}

/* ─────────────────────────── Windows: WinMM ────────────────────────── */
#elif SCR_MIDI_WINMM

static int scr_midi_plat_count(bool is_input) {
  return (int)(is_input ? midiInGetNumDevs() : midiOutGetNumDevs());
}

static bool scr_midi_plat_name(bool is_input, int idx, char *buf, size_t bufsz) {
  if (idx < 0) return false;
  if (is_input) {
    MIDIINCAPSA caps;
    if ((UINT)idx >= midiInGetNumDevs()) return false;
    if (midiInGetDevCapsA((UINT_PTR)idx, &caps, sizeof caps) != MMSYSERR_NOERROR) return false;
    snprintf(buf, bufsz, "%s", caps.szPname);
  } else {
    MIDIOUTCAPSA caps;
    if ((UINT)idx >= midiOutGetNumDevs()) return false;
    if (midiOutGetDevCapsA((UINT_PTR)idx, &caps, sizeof caps) != MMSYSERR_NOERROR) return false;
    snprintf(buf, bufsz, "%s", caps.szPname);
  }
  return true;
}

/* A loopback socketpair — the win32 self-pipe over WSAPoll (scr_loop_
 * wsapoll.c watches SOCKETs). Producer (the WinMM callback thread) writes
 * one byte; the loop drains the read end. */
static int scr_midi_win_selfpipe(int fds[2]) {
  SOCKET listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (listener == INVALID_SOCKET) return -1;
  struct sockaddr_in a;
  memset(&a, 0, sizeof a);
  a.sin_family = AF_INET;
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  a.sin_port = 0;
  int len = sizeof a;
  if (bind(listener, (struct sockaddr *)&a, len) != 0 || listen(listener, 1) != 0 ||
      getsockname(listener, (struct sockaddr *)&a, &len) != 0) {
    closesocket(listener);
    return -1;
  }
  SOCKET w = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (w == INVALID_SOCKET || connect(w, (struct sockaddr *)&a, len) != 0) {
    closesocket(listener);
    if (w != INVALID_SOCKET) closesocket(w);
    return -1;
  }
  SOCKET r = accept(listener, NULL, NULL);
  closesocket(listener);
  if (r == INVALID_SOCKET) {
    closesocket(w);
    return -1;
  }
  u_long one = 1;
  ioctlsocket(r, FIONBIO, &one);
  fds[0] = (int)r;
  fds[1] = (int)w;
  return 0;
}

/* The WinMM input callback — RUNS OFF-THREAD. Heap-free: copy to the ring,
 * poke the pipe. */
static void CALLBACK scr_midi_win_in_cb(HMIDIIN h, UINT msg, DWORD_PTR inst, DWORD_PTR p1,
                                        DWORD_PTR p2) {
  (void)h;
  (void)p2;
  ScrMidiInput *s = (ScrMidiInput *)inst;
  double now = scr_midi_now_ms();
  if (msg == MIM_DATA) {
    unsigned char b[3];
    DWORD dw = (DWORD)p1;
    b[0] = (unsigned char)(dw & 0xFF);
    b[1] = (unsigned char)((dw >> 8) & 0xFF);
    b[2] = (unsigned char)((dw >> 16) & 0xFF);
    /* Length by status: 1 byte for realtime/0xF*, else 2 or 3. Keep the
     * full 3 — the ignoreTypes filter and the JS consumer read the run;
     * trailing zero bytes on a 2-byte message are harmless for the common
     * decoders, but trim by status class for correctness. */
    size_t n = 3;
    unsigned char st = b[0];
    if (st >= 0xF8) n = 1;                       /* system realtime */
    else if ((st & 0xF0) == 0xC0 || (st & 0xF0) == 0xD0) n = 2; /* program/chanpress */
    else if (st == 0xF1 || st == 0xF3) n = 2;    /* MTC / song select */
    scr_midi_ring_push(s, b, n, now);
  } else if (msg == MIM_LONGDATA) {
    MIDIHDR *hdr = (MIDIHDR *)p1;
    if (hdr && hdr->dwBytesRecorded > 0)
      scr_midi_ring_push(s, (unsigned char *)hdr->lpData, hdr->dwBytesRecorded, now);
    /* re-queue the sysex buffer */
    if (hdr) midiInAddBuffer(s->h, hdr, sizeof *hdr);
  } else {
    return;
  }
  if (s->pipe_w >= 0) {
    char one = 1;
    send((SOCKET)s->pipe_w, &one, 1, 0);
  }
}

static const char *scr_midi_plat_in_open(ScrMidiInput *s, int idx, const char *vname) {
  (void)vname;
  if (idx < 0) return "MIDI: virtual ports are not supported on Windows (WinMM)";
  if ((UINT)idx >= midiInGetNumDevs()) return "MIDI: port index out of range";
  int fds[2];
  if (scr_midi_win_selfpipe(fds) != 0) return "MIDI: could not create wake pipe";
  s->pipe_r = fds[0];
  s->pipe_w = fds[1];
  scr_midi_watch_read(s->pipe_r, s, true);
  if (midiInOpen(&s->h, (UINT)idx, (DWORD_PTR)scr_midi_win_in_cb, (DWORD_PTR)s,
                 CALLBACK_FUNCTION) != MMSYSERR_NOERROR) {
    scr_midi_plat_in_close(s);
    return "MIDI: could not open input port";
  }
  memset(&s->sysex_hdr, 0, sizeof s->sysex_hdr);
  s->sysex_hdr.lpData = s->sysex_buf;
  s->sysex_hdr.dwBufferLength = sizeof s->sysex_buf;
  midiInPrepareHeader(s->h, &s->sysex_hdr, sizeof s->sysex_hdr);
  midiInAddBuffer(s->h, &s->sysex_hdr, sizeof s->sysex_hdr);
  midiInStart(s->h);
  return NULL;
}

static void scr_midi_plat_in_close(ScrMidiInput *s) {
  if (s->h) {
    midiInStop(s->h);
    midiInReset(s->h);
    midiInUnprepareHeader(s->h, &s->sysex_hdr, sizeof s->sysex_hdr);
    midiInClose(s->h);
    s->h = NULL;
  }
  if (s->pipe_r >= 0) {
    scr_midi_forget_fd(s->pipe_r);
    closesocket((SOCKET)s->pipe_r);
    s->pipe_r = -1;
  }
  if (s->pipe_w >= 0) {
    closesocket((SOCKET)s->pipe_w);
    s->pipe_w = -1;
  }
}

static void scr_midi_plat_in_pump(ScrMidiInput *s) {
  if (s->pipe_r < 0) return;
  char buf[256];
  while (recv((SOCKET)s->pipe_r, buf, sizeof buf, 0) > 0) { /* drain */
  }
}

static const char *scr_midi_plat_out_open(ScrMidiOutput *s, int idx, const char *vname) {
  (void)vname;
  if (idx < 0) return "MIDI: virtual ports are not supported on Windows (WinMM)";
  if ((UINT)idx >= midiOutGetNumDevs()) return "MIDI: port index out of range";
  if (midiOutOpen(&s->h, (UINT)idx, 0, 0, CALLBACK_NULL) != MMSYSERR_NOERROR)
    return "MIDI: could not open output port";
  return NULL;
}

static void scr_midi_plat_out_close(ScrMidiOutput *s) {
  if (s->h) {
    midiOutReset(s->h);
    midiOutClose(s->h);
    s->h = NULL;
  }
}

static void scr_midi_plat_out_send(ScrMidiOutput *s, const unsigned char *bytes, size_t len) {
  if (!s->h) return;
  if (len <= 3 && bytes[0] != 0xF0) {
    DWORD dw = 0;
    for (size_t i = 0; i < len; i++) dw |= (DWORD)bytes[i] << (8 * i);
    midiOutShortMsg(s->h, dw);
  } else {
    MIDIHDR hdr;
    memset(&hdr, 0, sizeof hdr);
    hdr.lpData = (LPSTR)bytes;
    hdr.dwBufferLength = (DWORD)len;
    hdr.dwBytesRecorded = (DWORD)len;
    if (midiOutPrepareHeader(s->h, &hdr, sizeof hdr) == MMSYSERR_NOERROR) {
      midiOutLongMsg(s->h, &hdr, sizeof hdr);
      midiOutUnprepareHeader(s->h, &hdr, sizeof hdr);
    }
  }
}

/* ─────────────────────────── stub (no backend) ─────────────────────── */
#else

static int scr_midi_plat_count(bool is_input) {
  (void)is_input;
  return 0;
}
static bool scr_midi_plat_name(bool is_input, int idx, char *buf, size_t bufsz) {
  (void)is_input;
  (void)idx;
  (void)buf;
  (void)bufsz;
  return false;
}
static const char *scr_midi_plat_in_open(ScrMidiInput *s, int idx, const char *vname) {
  (void)s;
  (void)idx;
  (void)vname;
  return "MIDI: no MIDI backend on this platform";
}
static void scr_midi_plat_in_close(ScrMidiInput *s) { (void)s; }
static void scr_midi_plat_in_pump(ScrMidiInput *s) { (void)s; }
static const char *scr_midi_plat_out_open(ScrMidiOutput *s, int idx, const char *vname) {
  (void)s;
  (void)idx;
  (void)vname;
  return "MIDI: no MIDI backend on this platform";
}
static void scr_midi_plat_out_close(ScrMidiOutput *s) { (void)s; }
static void scr_midi_plat_out_send(ScrMidiOutput *s, const unsigned char *bytes, size_t len) {
  (void)s;
  (void)bytes;
  (void)len;
}

#endif /* backend selection */
