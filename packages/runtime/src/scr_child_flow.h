/* child.stdout / child.stderr flow control: pause(), resume(), isPaused()
 * and readableFlowing on the piped-output handle (ScrChildStream).
 *
 * This is the state of scr_child.c's SCR_CHILD_STREAM_FLOW build, which a
 * program selects by calling one of those members on a child stream. Every
 * other program links the default build, where a stream reads its pipe
 * only while a 'data' listener exists and holds nothing itself. The
 * operations are in scr_child_flow_impl.h, which each platform arm of the
 * flow build includes.
 *
 * Node's rules (lib/internal/streams/readable.js, net.js and
 * internal/child_process.js of the pinned release), as they apply to a
 * child's output socket:
 * - pause() makes the stream not flowing: no 'data' fires. The stream keeps
 *   reading into its buffer until that holds the high-water mark, then
 *   stops reading; the kernel buffer fills and the child blocks.
 * - resume() makes it flowing at once and drains on the next tick: the
 *   buffered chunks in order, as they were read, for as long as the stream
 *   stays flowing (a listener that pauses stops the drain). A flowing
 *   stream reads and emits with or without listeners.
 * - on("data") does not resume a stream that was paused explicitly.
 * - EOF on a stream that still holds chunks owes 'end': it fires one tick
 *   after the read that takes the last of them, even if that chunk's
 *   listener pauses again, and the child's 'close' waits for it. A paused
 *   stream that holds nothing at EOF ends at once.
 * - When the child exits, Node resumes each of its stdio streams on the
 *   tick after the 'exit' listeners (flushStdio), so a pause() does not
 *   outlive the child unless it is made later.
 * - After 'end', pause() and resume() only change what isPaused() and
 *   readableFlowing answer.
 *
 * A stream that was never paused or resumed keeps the default build's
 * behaviour here too (SCR_CHILD_FLOW_NONE).
 *
 * Two limits. The buffer is counted in bytes read, also when an encoding
 * is set (Node counts the decoded string's length there). And a stream the
 * runtime captures for an exec()/execFile() callback is read for that
 * capture while paused, so pausing it holds its listeners back but does
 * not block the child; what it holds back is delivered when the child
 * exits, before the callback. The call's maxBuffer bounds what is read
 * that way: it is counted as the capture takes each chunk, so a child that
 * writes past it while its stream is paused is ended with Node's maxBuffer
 * error then, where Node ends it when the stream is resumed.
 */
#ifndef SCR_CHILD_FLOW_H
#define SCR_CHILD_FLOW_H

/* Node 24's default highWaterMark of a byte stream (64 KiB). */
#define SCR_CHILD_FLOW_HWM 65536

enum {
  SCR_CHILD_FLOW_NONE = 0,   /* never paused or resumed */
  SCR_CHILD_FLOW_PAUSED = 1, /* readableFlowing === false */
  SCR_CHILD_FLOW_FLOWING = 2 /* resume() or the exit flush */
};

/* One chunk held back, as the listeners will get it. */
typedef struct ScrChildFlowChunk {
  struct ScrChildFlowChunk *next;
  ScrBytes *bytes; /* +1; NULL when the stream decoded the chunk */
  ScrStr *text;    /* +1; the decoded chunk, NULL without an encoding */
  size_t len;      /* the bytes it counts toward the high-water mark */
} ScrChildFlowChunk;

typedef struct {
  unsigned char state; /* SCR_CHILD_FLOW_* */
  bool listened;       /* a 'data' listener was registered (readableFlowing) */
  bool ended;          /* the pipe hit EOF and 'end' is owed */
  bool drain_tick;     /* a drain tick is queued (Node's resumeScheduled) */
  bool end_tick;       /* the tick that delivers the owed 'end' is queued */
  ScrChildFlowChunk *head, *tail;
  size_t len; /* bytes held back */
} ScrChildFlow;

/* Called by the stream's release, which each arm defines before it
 * includes the operations. */
static void scr_child_flow_free(ScrChildStream *s);

#endif /* SCR_CHILD_FLOW_H */
