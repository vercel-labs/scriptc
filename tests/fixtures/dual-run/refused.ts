// WebSocket is a Node global the native runtime does not provide: the
// ambient declaration makes the name a global (as @types/node does), and
// constructing it refuses with SC2020, which the program API reports as a
// DualRunBuildError.
interface HostSocket {
  readonly readyState: number;
}
declare var WebSocket: {
  new (url: string): HostSocket;
};
const socket = new WebSocket("ws://localhost:8080");
console.log(socket.readyState);
