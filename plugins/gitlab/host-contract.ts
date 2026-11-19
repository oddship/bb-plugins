import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const hostContract = defineRpcContract({
  run: {
    input: z
      .object({
        binary: z.string().min(1).max(1024),
        args: z.array(z.string().max(10000)).min(1).max(100),
        input: z.string().max(100000).optional(),
      })
      .strict(),
    output: z.string().max(4 * 1024 * 1024),
  },
});
