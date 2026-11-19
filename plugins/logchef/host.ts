import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract";
import { readLogchef } from "./logchef";
export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: { read: (i, c) => readLogchef(i.request, i.binaryPath, c.signal) },
});
