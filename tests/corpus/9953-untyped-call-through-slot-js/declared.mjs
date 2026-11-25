// A function declared without types.
export function plain(payload) {
  const diff = payload == null ? undefined : payload.diff;
  return "plain " + JSON.stringify(payload) + " diff=" + String(diff);
}
