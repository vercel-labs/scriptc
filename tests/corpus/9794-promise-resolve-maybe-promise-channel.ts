// A function answers `T | Promise<T>` and its result is handed straight to a promise's resolve
// function, whose parameter welcomes both arms: the value fulfils, the promise is adopted.
interface Channel {
  post: (text: string) => void;
  stop: () => Promise<void>;
}
function launch(now: boolean): Channel | Promise<Channel> {
  const channel: Channel = {
    post: (text) => console.log("post", text),
    stop: async () => {
      console.log("stop", now);
    },
  };
  return now ? channel : Promise.resolve(channel);
}
function fail(): Channel | Promise<Channel> {
  return Promise.reject<Channel>(new Error("no channel"));
}
for (const now of [true, false]) {
  new Promise<Channel>((resolve) => resolve(launch(now))).then(
    (channel) => {
      channel.post(String(now));
      void channel.stop();
    },
    (error) => console.log("failed:", (error as Error).message),
  );
}
new Promise<Channel>((resolve) => resolve(fail())).then(
  (channel) => channel.post("unreachable"),
  (error) => console.log("failed:", (error as Error).message),
);
