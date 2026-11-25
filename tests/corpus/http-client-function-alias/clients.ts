import * as http from "node:http";
import * as https from "node:https";

export const httpRequest = http.request;
export const httpsRequest = https.request;
export const httpGet = http.get;
export const httpsGet = https.get;
