// A binding that code can read before its first store is handed to a
// listener parameter as the function it declares: the parameter count rule
// reads that function, so two declared parameters are still refused.
import * as http from "node:http";

function attach(): void {
  let two: (error: Error, extra?: number) => void;
  let one: (error: Error) => void;
  const install = (): void => {
    two = (error, extra) => console.log(error.message, extra);
    one = (error) => console.log(error.message);
  };
  const server = http.createServer();
  const arm = (): void => {
    server.on("error", one);
    server.on("error", two);
  };
  install();
  arm();
}
attach();

// An optional callback keeps the stored value, which the listen call cannot
// take: the refusal says so.
function listen(): void {
  let ready: () => void;
  const install = (): void => {
    ready = () => console.log("listening");
  };
  const server = http.createServer();
  const arm = (): void => {
    server.listen(0, "127.0.0.1", ready);
  };
  install();
  arm();
}
listen();
