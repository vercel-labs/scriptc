export function drain(queue) {
  const first = queue.take();
  const second = queue.take();
  return `${first === null ? "null" : first.value} ${second === null ? "null" : second.value}`;
}
