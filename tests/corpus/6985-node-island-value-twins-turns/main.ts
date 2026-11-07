// @requires-libnode
// A native Date and URL that both sides keep and both sides write, in
// turns: across calls, from a callback the island calls, from the island's
// own timers and promises, and from native timers while the island holds
// its object. Every read sees the last write, whoever made it.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

interface Session {
  started: Date;
  endpoint: URL;
  attempts: number;
}

async function main(): Promise<void> {
  const session: Session = {
    started: new Date(1000),
    endpoint: new URL("http://example.test/v1?page=1"),
    attempts: 0,
  };
  lib.open(session);

  // Turns across calls.
  session.started.setTime(2000);
  console.log("native wrote", lib.read());
  lib.advance(500, "2");
  console.log("island wrote", session.started.getTime(), session.endpoint.href);
  session.started.setTime(session.started.getTime() + 1);
  session.endpoint.searchParams.set("page", "3");
  lib.advance(10, "4");
  session.endpoint.hash = "#top";
  console.log("both wrote", session.started.getTime(), session.endpoint.href, lib.read());

  // A callback the island calls: the callback sees the island's write and
  // the island sees the callback's.
  const seen: string = lib.around((): string => {
    const before = session.started.getTime();
    session.started.setTime(before * 2);
    session.endpoint.pathname = "/v2";
    return String(before);
  });
  console.log("callback", seen, session.started.getTime(), session.endpoint.pathname);

  // The island writes later, from its own timer, with no call in between.
  const done: Promise<string> = lib.later(7000, "/v3");
  session.started.setTime(6000);
  console.log("before the timer", await done);
  console.log("after the timer", session.started.getTime(), session.endpoint.pathname);

  // The program writes from its own timer while the island reads from its.
  const read: Promise<string> = lib.readLater();
  setTimeout(() => {
    session.started.setTime(9000);
    session.endpoint.port = "8443";
  }, 1);
  console.log("island read after the native timer", await read);

  // A promise the island settles with the program's own values.
  const settled: Session = await lib.settle();
  console.log(
    "settled",
    settled.started === session.started,
    settled.endpoint === session.endpoint,
    settled.started.getTime(),
  );

  // Many writes on each side between crossings: only the last one counts.
  for (let i = 0; i < 1000; i++) session.started.setTime(i);
  console.log("after a native loop", lib.read());
  lib.spin(1000);
  console.log("after an island loop", session.started.getTime(), session.endpoint.searchParams.get("page"));
}
main();
