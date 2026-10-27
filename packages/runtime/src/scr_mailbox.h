#ifndef SCR_MAILBOX_H
#define SCR_MAILBOX_H

#include "scr_message.h"

typedef struct ScrMailbox ScrMailbox;
typedef struct ScrMailEvent {
  unsigned kind;
  uint64_t source;
  int code;
  ScrMessage *message;
  unsigned char *data; /* raw bytes (a worker's captured stdout or stderr), owned */
  size_t length;
  struct ScrMailEvent *next;
  bool in_message; /* the event is the one message's block holds (scr_message_mail_event) */
} ScrMailEvent;

/* The event that carries `message`, in the message's own block: a queued
 * message is then one allocation. Freeing the event frees the message. */
ScrMailEvent *scr_message_mail_event(ScrMessage *message);

ScrMailbox *scr_mailbox_new(void);
ScrMailbox *scr_mailbox_retain(ScrMailbox *mailbox);
void scr_mailbox_release(ScrMailbox *mailbox);
/* Posting always consumes the event, including when the destination is
 * closed. Taking returns an owned event; no runtime object crosses a queue. */
bool scr_mailbox_post(ScrMailbox *mailbox, ScrMailEvent *event);
ScrMailEvent *scr_mailbox_take(ScrMailbox *mailbox);
/* The first queued event with this kind and source, or NULL. */
ScrMailEvent *scr_mailbox_take_kind(ScrMailbox *mailbox, unsigned kind, uint64_t source);
void scr_mail_event_free(ScrMailEvent *event);
void scr_mailbox_close(ScrMailbox *mailbox);
bool scr_mailbox_pending(ScrMailbox *mailbox);
/* The kind of the first queued event, or 0 when none is queued. */
unsigned scr_mailbox_head_kind(ScrMailbox *mailbox);
/* The number of queued events of this kind, kept as events are posted and
 * taken; 0 for kinds of 16 and above. */
size_t scr_mailbox_count_kind(ScrMailbox *mailbox, unsigned kind);
void scr_mailbox_wait(ScrMailbox *mailbox, double milliseconds);
int scr_mailbox_pollfd(const ScrMailbox *mailbox);

/* A MessageChannel: two ends, each with its queue of incoming messages and
 * the inbox of the thread that owns its port (NULL while the port is in
 * transit). Posting and closing wake the receiving owner with a wake_kind
 * event. Ends are thread-neutral, so a port can move between threads. */
typedef struct ScrChannel ScrChannel;
ScrChannel *scr_channel_new(void);
ScrChannel *scr_channel_retain(ScrChannel *channel);
void scr_channel_release(ScrChannel *channel);
void scr_channel_set_owner(ScrChannel *channel, int side, ScrMailbox *owner, unsigned wake_kind);
/* Consumes message; false when either end has closed (the message is dropped). */
bool scr_channel_post(ScrChannel *channel, int side, ScrMessage *message, unsigned message_kind,
                      unsigned wake_kind);
/* close() stops posting both ways; notify_close, once the closed port's
 * 'close' ran, tells the other end (after its queued messages). */
void scr_channel_close(ScrChannel *channel, int side);
void scr_channel_notify_close(ScrChannel *channel, int side, unsigned wake_kind);
ScrMailEvent *scr_channel_take(ScrChannel *channel, int side);
size_t scr_channel_count(ScrChannel *channel, int side);
uint64_t scr_channel_peer_closed(ScrChannel *channel, int side); /* the notice's order, 0: none */
void scr_channel_drop(ScrChannel *channel, int side);

/* BroadcastChannel: the process-wide registry of open channels by name.
 * Each instance's channel queues its messages on end 0 (posts go through
 * side 1). peers answers the others with the name (+1 each, array
 * malloc'd). */
void scr_broadcast_join(const char *name, size_t length, ScrChannel *channel);
void scr_broadcast_leave(ScrChannel *channel);
size_t scr_broadcast_peers(const char *name, size_t length, ScrChannel *self, ScrChannel ***out);

#endif
