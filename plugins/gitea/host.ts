import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract.js";
import { createTea } from "./tea.js";
const tea = createTea();
export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    logins: (_, c) => tea.logins(c.signal),
    repos: (i, c) => tea.repos(i.login, i.page, c.signal),
    items: (i, c) =>
      tea.items(i.login, i.repo, i.kind, i.state, i.page, c.signal),
    detail: (i, c) => tea.detail(i.login, i.repo, i.kind, i.number, c.signal),
  },
});
