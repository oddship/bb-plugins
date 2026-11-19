import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract";
import { Collector } from "./lib/collector";
const collector = new Collector();
export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: { sample: ({ sessionOwners }) => collector.sample(sessionOwners) },
  dispose: () => collector.dispose(),
});
