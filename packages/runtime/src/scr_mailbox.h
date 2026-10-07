#ifndef SCR_MAILBOX_H
#define SCR_MAILBOX_H

#include "scr_message.h"

typedef struct ScrMailbox ScrMailbox;
typedef struct ScrMailEvent {
  unsigned kind;
  uint64_t source;
  int code;
  ScrMessage *message;
  struct ScrMailEvent *next;
} ScrMailEvent;

ScrMailbox *scr_mailbox_new(void);
ScrMailbox *scr_mailbox_retain(ScrMailbox *mailbox);
void scr_mailbox_release(ScrMailbox *mailbox);
/* Posting always consumes the event, including when the destination is
 * closed. Taking returns an owned event; no runtime object crosses a queue. */
bool scr_mailbox_post(ScrMailbox *mailbox, ScrMailEvent *event);
ScrMailEvent *scr_mailbox_take(ScrMailbox *mailbox);
void scr_mail_event_free(ScrMailEvent *event);
void scr_mailbox_close(ScrMailbox *mailbox);
bool scr_mailbox_pending(ScrMailbox *mailbox);
void scr_mailbox_wait(ScrMailbox *mailbox, double milliseconds);
int scr_mailbox_pollfd(const ScrMailbox *mailbox);

#endif
