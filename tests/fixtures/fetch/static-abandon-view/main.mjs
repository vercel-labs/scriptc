// A compressed body whose web-stream members were read, then dropped unread
// with its Response before HTTP EOF, must settle the native transfer: the
// body's ReadableStream view does not keep it alive. Otherwise its paused
// socket keeps the process alive while the server waits to send the rest.
async function inspect() {
  const response = await fetch(`${process.argv[2]}/gzip-incompressible`);
  return [typeof response.body.tee, response.body.locked];
}
console.log(...(await inspect()));
console.log("abandoned inspected compressed response");
