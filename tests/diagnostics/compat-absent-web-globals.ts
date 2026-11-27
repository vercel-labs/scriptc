// Web-platform globals Node 24 defines and scriptc does not implement:
// each use below is refused by name, which is the evidence the
// compatibility ledger cites for marking these rows a verified absence
// rather than an unverified registry gap. (URLPattern and the compression
// streams are here implemented, and Node 24 defines EventSource only under
// --experimental-eventsource, so a default process does not have that name at
// all: neither is an absence this ledger can cite.)
const socket = new WebSocket("ws://localhost:1");
socket.close();

