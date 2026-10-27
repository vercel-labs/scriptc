// undici's diagnostics_channel publications (lib/core/diagnostics.js). The
// channel names and message shapes are undici's; subscribers see the same
// request objects across one request's lifetime.
import { channel } from "node:diagnostics_channel";

export const channels = {
  create: channel("undici:request:create"),
  bodySent: channel("undici:request:bodySent"),
  headers: channel("undici:request:headers"),
  trailers: channel("undici:request:trailers"),
  error: channel("undici:request:error"),
  beforeConnect: channel("undici:client:beforeConnect"),
  connected: channel("undici:client:connected"),
  connectError: channel("undici:client:connectError"),
  sendHeaders: channel("undici:client:sendHeaders"),
};
