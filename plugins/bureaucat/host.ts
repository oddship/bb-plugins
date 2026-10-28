import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract.js";
import { runBcat } from "./bcat.js";
export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    execute: (i, c) => runBcat(i.binary, i.request, i.baseUrl, c.signal),
  },
});
