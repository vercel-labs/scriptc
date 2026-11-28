// Web-platform globals Node 24 defines and scriptc does not implement:
// each use below is refused by name, which is the evidence the
// compatibility ledger cites for marking these rows a verified absence
// rather than an unverified registry gap. (WebSocket is implemented, and
// EventSource exists in Node 24 only under --experimental-eventsource, so a
// default Node process does not have that name at all: neither is an absence
// this ledger can cite.)

const pattern = new URLPattern({ pathname: "/books/:id" });
console.log(pattern.test("http://localhost/books/1"));
