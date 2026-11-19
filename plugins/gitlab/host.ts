import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./host-contract.js";
import { createRunner } from "./glab.js";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    run: (input, context) =>
      createRunner(input.binary, context.lifecycle.signal)(
        input.args,
        context.signal,
        input.input,
      ),
  },
});
