#ifndef SCR_MESSAGE_H
#define SCR_MESSAGE_H

#include "scr_runtime.h"

/* Queues own messages independently of either runtime heap. Encoding may
 * invoke getters and throw on the sender. Decoding creates recipient-local
 * values; release the message separately after delivery or cancellation. */
typedef struct ScrMessage ScrMessage;
ScrMessage *scr_message_encode(const ScrDyn *value);
/* postMessage(value, transferList): the listed MessagePorts move with the
 * message (a port in the value that is not listed throws DataCloneError);
 * transfer is NULL or a dyn array. */
ScrMessage *scr_message_encode_transfer(const ScrDyn *value, const ScrDyn *transfer);
/* A worker's uncaught exception, as Node's error serializer sends it: an
 * Error keeps the nearest of Error and its six native subclasses, and its
 * name, message and other data properties (functions and symbols aside)
 * with their enumerability, own or inherited; its cause encodes the same
 * way. Other values encode as scr_message_encode encodes them. */
ScrMessage *scr_message_encode_uncaught(const ScrDyn *value);

/* MessagePort transfer, installed by the worker events unit: channel_of
 * answers a channel port's end (+1 channel; NULL for other values, side
 * set), is_port any MessagePort, detach leaves the sender's port unusable,
 * adopt makes a port in the decoding thread (the channel borrowed). */
typedef struct ScrChannel ScrChannel;
typedef struct {
  ScrChannel *(*channel_of)(const ScrDyn *value, int *side);
  bool (*is_port)(const ScrDyn *value);
  void (*detach)(const ScrDyn *value);
  ScrDyn *(*adopt)(ScrChannel *channel, int side);
  void (*release)(ScrChannel *channel);
} ScrMessagePortOps;
extern const ScrMessagePortOps *scr_message_port_ops;
ScrDyn *scr_message_decode(const ScrMessage *message);
void scr_message_free(ScrMessage *message);

#endif
