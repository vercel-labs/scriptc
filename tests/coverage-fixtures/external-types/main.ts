import { hostVersion, type HostPoint } from "@native-sdk/core";

function magnitude(point: HostPoint): number {
  return point.x + point.y;
}

const point: HostPoint = { x: 20, y: 22 };
console.log(magnitude(point));
console.log(hostVersion());
