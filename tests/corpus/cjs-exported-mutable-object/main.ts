// An exported object with a slot the checker types null until another module
// fills it. The importer writes the field directly, the defining module reads
// it later and calls the function, and a write made through the package's own
// function is seen the same way. Node prints the two lines below.

import { install, read, state } from "statepkg";

read();

state.sink = () => {
  console.log("direct write");
};
read();

install(() => {
  console.log("installed");
});
read();
