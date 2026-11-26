// Web-platform globals Node 24 defines and scriptc does not implement:
// each use below is refused by name, which is the evidence the
// compatibility ledger cites for marking these rows a verified absence
// rather than an unverified registry gap. (EventSource is not here: Node 24
// defines it only under --experimental-eventsource, so a default process
// does not have the name at all.)
const socket = new WebSocket("ws://localhost:1");
socket.close();

const pattern = new URLPattern({ pathname: "/books/:id" });
console.log(pattern.test("http://localhost/books/1"));

const gzip = new CompressionStream("gzip");
const gunzip = new DecompressionStream("gzip");
console.log(typeof gzip.readable, typeof gunzip.writable);
