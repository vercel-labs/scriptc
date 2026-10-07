#ifndef SCR_MESSAGE_H
#define SCR_MESSAGE_H

#include "scr_runtime.h"

/* Queues own messages independently of either runtime heap. Encoding may
 * invoke getters and throw on the sender. Decoding creates recipient-local
 * values; release the message separately after delivery or cancellation. */
typedef struct ScrMessage ScrMessage;
ScrMessage *scr_message_encode(const ScrDyn *value);
ScrDyn *scr_message_decode(const ScrMessage *message);
void scr_message_free(ScrMessage *message);

#endif
