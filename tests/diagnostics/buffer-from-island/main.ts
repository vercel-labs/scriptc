// @dynamic
// A package call keeps its value in the island even when its declaration
// promises a supported container. Buffer.from must fence that boundary.
import { bytes, numbers } from "bytekit";
Buffer.from(bytes());
Buffer.from(numbers());
void 0;
