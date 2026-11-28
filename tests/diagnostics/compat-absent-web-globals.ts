// Web-platform globals Node 24 defines and scriptc does not implement:
// each use below is refused by name, which is the evidence the
// compatibility ledger cites for marking these rows a verified absence
// rather than an unverified registry gap. (URLPattern, the compression
// streams and the global WebSocket are here implemented, and Node 24 defines
// EventSource only under --experimental-eventsource, so a default process
// does not have that name at all: none of them is an absence this ledger can
// cite. The global FormData and node:http's WebSocket export still are.)
import { WebSocket } from "node:http";

new FormData();
const socket = new WebSocket("ws://localhost:1");
socket.close();
