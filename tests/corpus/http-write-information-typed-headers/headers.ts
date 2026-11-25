// Headers a JavaScript module imports as typed records: the record crosses
// into the checked-dynamic writeInformation ladder as a typed reference,
// which the runtime materializes before it reads the entries.
export const plainHeaders: Record<string, string> = { "X-A": "1", "X-B": "2" };

export const mixedHeaders: Record<string, string | string[] | number> = {
  "X-Count": 3,
  "X-List": ["a", "b"],
  "X-Plain": "v",
};
