// Dropping an unread compressed Response after HTTP EOF must settle the
// native transfer immediately. Otherwise its paused keep-alive socket keeps
// the process alive until the peer times out the connection.
await fetch(`${process.argv[2]}/gzip-pressure`);
console.log("abandoned compressed response");
