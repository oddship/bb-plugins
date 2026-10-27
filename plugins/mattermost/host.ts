import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { hostContract } from "./contract";
import { readMm } from "./mm";
export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: { read: (request, context) => readMm(request, context.signal) },
});
