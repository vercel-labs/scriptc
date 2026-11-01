/* scriptc runtime — the generator handle's layout, shared by scr_async.c
 * (the generator runtime) and scr_gen_bind.c (the call-time parameter bind,
 * a unit only generators that bind at the call link). scr_async.c includes
 * it after scr_runtime.h. */
#ifndef SCR_GENERATOR_PRIVATE_H
#define SCR_GENERATOR_PRIVATE_H

enum {
  SCR_GEN_UNSTARTED = 0,
  SCR_GEN_SUSPENDED,
  SCR_GEN_AWAITING,
  SCR_GEN_RUNNING,
  SCR_GEN_DONE
};

/* One type-erased value slot: the exception cell's payload technique,
 * with only the release entry point (takes MOVE — nothing here retains). */
typedef struct {
  ScrExcKind kind; /* NONE / F64 / BOOL / REF (strings ride REF) */
  double f64;
  bool b;
  void *payload;
  void (*release_fn)(void *);
} ScrGenSlot;

enum { SCR_AG_NEXT = 0, SCR_AG_RETURN, SCR_AG_THROW };

typedef struct ScrAsyncGenRequest {
  int mode;
  ScrGenSlot arg;
  ScrExcCell thrown;
  ScrPromise *promise; /* owned until this request settles */
  struct ScrAsyncGenRequest *next;
} ScrAsyncGenRequest;

struct ScrGen {
  size_t rc;
  ScrDyn *receiver;
  ScrFiber *fiber; /* NULL once torn down (done, or unstarted release) */
  int state;
  ScrGenSlot out; /* yielded value / completion value */
  ScrGenSlot in;  /* the .next(v) argument */
  ScrGenSlot ret; /* a parked .return(v) value */
  /* The never-started teardown: drops the packed (already-retained)
   * arguments the spawn wrapper built. Emitted per generator function. */
  void (*drop_args)(void *);
  /* scr_gen_set_unstarted_return's hook; NULL for most generators. */
  void (*unstarted_return)(void *);
  const char *tag; /* scr_gen_set_tag's; NULL is the default */
  bool is_async;
  void (*settle_async)(ScrGen *, ScrPromise *);
  ScrAsyncGenRequest *requests_head;
  ScrAsyncGenRequest *requests_tail;
  ScrPromise *active_request;
  ScrExcCell async_error;
  bool settle_queued;
  bool success_hop_done;
  /* A return() request at a yield: the queued job resumes the body after
   * the return value's await (return_queued), and the body's completion,
   * on that request or a later one, settles without another turn
   * (return_awaited). An explicit `return x` during the unwind clears it,
   * since that return takes its own turn to await x. */
  bool return_queued;
  bool return_awaited;
  /* The AsyncLocalStorage context of a return() request deferred at a
   * yield (+1): the body's unwind runs in it, as Node resumes it from the
   * return value's await. */
  ScrAlsCtx *return_ctx;
#ifdef SCR_WORKERS
  bool context_abandoned;
#endif
};

#endif
