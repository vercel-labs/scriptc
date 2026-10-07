class Link { previous: Link | undefined = undefined; value = 0; }
class DerivedLink extends Link { label = "node"; }
function chain(length: number): void {
  let head: Link | undefined;
  for (let i = 0; i < length; i++) {
    const next = i % 2 === 0 ? new Link() : new DerivedLink();
    next.previous = head;
    next.value = i;
    head = next;
  }
  console.log(head?.value);
}
chain(250_000);
console.log("released");
class Branch { children: Branch[] = []; value = 0; }
function branches(length: number): void {
  let head = new Branch();
  for (let i = 0; i < length; i++) {
    const next = new Branch();
    next.children.push(head);
    next.value = i;
    head = next;
  }
  console.log(head.value);
}
branches(100_000);
console.log("containers released");

function checkedContainers(length: number): void {
  let head: unknown = undefined;
  for (let i = 0; i < length; i++) head = [head];
  console.log(Array.isArray(head));
  head = undefined;
  for (let i = 0; i < length; i++) {
    const next = new Map<unknown, unknown>();
    next.set("previous", head);
    head = next;
  }
  console.log(head instanceof Map);
}
checkedContainers(5_000);
console.log("checked containers released");

function errorCauses(length: number): void {
  let head: unknown = undefined;
  for (let i = 0; i < length; i++) head = new Error("linked", { cause: head });
  console.log(head instanceof Error);
}
errorCauses(512);
console.log("causes released");

function capturedClosures(length: number): void {
  let head: () => number = () => 0;
  for (let i = 0; i < length; i++) {
    const previous = head;
    head = () => previous();
  }
  console.log(typeof head);
}
capturedClosures(5_000);
console.log("captures released");
