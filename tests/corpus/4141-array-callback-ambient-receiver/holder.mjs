import { mapPeek } from "./mapper.ts";

// A method call binds `holder` as the receiver while mapPeek runs.
export const holder = {
  label: "holder",
  run() {
    return `${typeof this} ${mapPeek()}`;
  },
};
