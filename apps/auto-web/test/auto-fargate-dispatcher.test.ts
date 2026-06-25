/**
 * Fargate dispatcher — the HOSTED-AWS run-execution dispatch path (NOT used on
 * DOKS, but still shipped). Asserts (with an INJECTED RunTask impl — NO real AWS,
 * NO ECS client) that on dispatch it launches one Fargate task from the configured
 * task definition, injecting ONLY RUN_ID into the worker container override, and
 * that a missing required env / a RunTask failure surfaces a clear error.
 */

import { describe, expect, it } from "vitest";
import {
  makeFargateDispatcher,
  type RunTaskResult,
} from "@/server/core/auto-fargate-dispatcher";
import type { RunTaskCommandInput } from "@aws-sdk/client-ecs";

const FARGATE_ENV: Record<string, string | undefined> = {
  AUTO_ECS_CLUSTER: "auto-cluster",
  AUTO_ECS_TASK_DEF: "agentkit-auto-worker",
  AUTO_ECS_SUBNET_IDS: "subnet-a,subnet-b",
  AUTO_ECS_SECURITY_GROUP_ID: "sg-123",
};

/** The AutoDispatcher signature is (runId, opts, billing); the Fargate dispatcher
 *  ignores opts + billing (the worker re-resolves both over the service key). */
const OPTS = {} as never;
const BILLING = { inferenceMode: "managed", isCloudRun: true, cloudRunCentsPerMin: 1 } as never;

describe("makeFargateDispatcher", () => {
  it("launches one task injecting ONLY RUN_ID into the worker override", async () => {
    const calls: RunTaskCommandInput[] = [];
    const runTaskImpl = async (input: RunTaskCommandInput): Promise<RunTaskResult> => {
      calls.push(input);
      return { tasks: [{ taskArn: "arn:task/1" }] };
    };
    const dispatch = makeFargateDispatcher({ runTaskImpl, env: FARGATE_ENV });

    await dispatch("run-42", OPTS, BILLING);

    expect(calls).toHaveLength(1);
    const input = calls[0];
    expect(input.cluster).toBe("auto-cluster");
    expect(input.taskDefinition).toBe("agentkit-auto-worker");
    expect(input.launchType).toBe("FARGATE");
    const overrides = input.overrides?.containerOverrides ?? [];
    expect(overrides).toHaveLength(1);
    expect(overrides[0].name).toBe("auto-worker");
    // ONLY RUN_ID — never a bearer token or billing/BYO key.
    expect(overrides[0].environment).toEqual([{ name: "RUN_ID", value: "run-42" }]);
    expect(input.networkConfiguration?.awsvpcConfiguration?.subnets).toEqual([
      "subnet-a",
      "subnet-b",
    ]);
  });

  it("fails loudly when required ECS env is missing", async () => {
    const runTaskImpl = async (): Promise<RunTaskResult> => ({ tasks: [{ taskArn: "x" }] });
    const dispatch = makeFargateDispatcher({ runTaskImpl, env: { AUTO_ECS_CLUSTER: "c" } });
    await expect(dispatch("run-1", OPTS, BILLING)).rejects.toThrow(/misconfigured: missing required env/);
  });

  it("surfaces a RunTask failure as a clear error", async () => {
    const runTaskImpl = async (): Promise<RunTaskResult> => ({
      failures: [{ reason: "capacity unavailable" }],
    });
    const dispatch = makeFargateDispatcher({ runTaskImpl, env: FARGATE_ENV });
    await expect(dispatch("run-1", OPTS, BILLING)).rejects.toThrow(/capacity unavailable/);
  });

  it("errors when RunTask returns no tasks (worker did not start)", async () => {
    const runTaskImpl = async (): Promise<RunTaskResult> => ({ tasks: [] });
    const dispatch = makeFargateDispatcher({ runTaskImpl, env: FARGATE_ENV });
    await expect(dispatch("run-1", OPTS, BILLING)).rejects.toThrow(/did not start/);
  });
});
