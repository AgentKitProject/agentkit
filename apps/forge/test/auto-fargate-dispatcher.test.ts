// FargateDispatcher unit tests — assert the RunTask parameters without real AWS.
//
// We inject a fake runTaskImpl so no ECS client is constructed and we can capture
// the exact RunTaskCommandInput the dispatcher builds.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeFargateDispatcher,
  type RunTaskImpl
} from "@/server/core/auto-fargate-dispatcher";

const REQUIRED_ENV: Record<string, string | undefined> = {
  AUTO_ECS_CLUSTER: "auto-cluster",
  AUTO_ECS_TASK_DEF: "auto-task-def:7",
  AUTO_ECS_SUBNET_IDS: "subnet-aaa, subnet-bbb ,subnet-ccc",
  AUTO_ECS_SECURITY_GROUP_ID: "sg-123"
};

const billing = { inferenceMode: "managed", isCloudRun: true, cloudRunCentsPerMin: 0 } as never;

describe("fargateDispatcher", () => {
  let captured: Parameters<RunTaskImpl>[0] | null;
  let runTaskImpl: RunTaskImpl;

  beforeEach(() => {
    captured = null;
    runTaskImpl = vi.fn(async (input) => {
      captured = input;
      return { tasks: [{ taskArn: "arn:aws:ecs:task/abc" }], failures: [] };
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("launches a FARGATE task with public IP, parsed subnets, the SG and a RUN_ID override", async () => {
    const dispatch = makeFargateDispatcher({ runTaskImpl, env: REQUIRED_ENV });
    await dispatch("run-42", {}, billing);

    expect(runTaskImpl).toHaveBeenCalledTimes(1);
    const input = captured!;
    expect(input.cluster).toBe("auto-cluster");
    expect(input.taskDefinition).toBe("auto-task-def:7");
    expect(input.launchType).toBe("FARGATE");
    expect(input.count).toBe(1);

    const awsvpc = input.networkConfiguration?.awsvpcConfiguration;
    expect(awsvpc?.assignPublicIp).toBe("ENABLED");
    // CSV parsed + trimmed into an array.
    expect(awsvpc?.subnets).toEqual(["subnet-aaa", "subnet-bbb", "subnet-ccc"]);
    expect(awsvpc?.securityGroups).toEqual(["sg-123"]);

    const override = input.overrides?.containerOverrides?.[0];
    expect(override?.name).toBe("auto-worker"); // default container name
    expect(override?.environment).toEqual([{ name: "RUN_ID", value: "run-42" }]);
    // The bearer / billing are NEVER placed in the task env.
    expect(JSON.stringify(input)).not.toContain("byo");
  });

  it("uses AUTO_ECS_CONTAINER_NAME override when set", async () => {
    const dispatch = makeFargateDispatcher({
      runTaskImpl,
      env: { ...REQUIRED_ENV, AUTO_ECS_CONTAINER_NAME: "custom-worker" }
    });
    await dispatch("run-1", {}, billing);
    expect(captured!.overrides?.containerOverrides?.[0]?.name).toBe("custom-worker");
  });

  it("throws when a required env var is missing", async () => {
    const dispatch = makeFargateDispatcher({
      runTaskImpl,
      env: { ...REQUIRED_ENV, AUTO_ECS_CLUSTER: undefined }
    });
    await expect(dispatch("run-1", {}, billing)).rejects.toThrow(/AUTO_ECS_CLUSTER/);
    expect(runTaskImpl).not.toHaveBeenCalled();
  });

  it("throws when no subnets are configured", async () => {
    const dispatch = makeFargateDispatcher({
      runTaskImpl,
      env: { ...REQUIRED_ENV, AUTO_ECS_SUBNET_IDS: "  ,  " }
    });
    await expect(dispatch("run-1", {}, billing)).rejects.toThrow(/AUTO_ECS_SUBNET_IDS/);
  });

  it("throws when RunTask reports a failure", async () => {
    const failing: RunTaskImpl = async () => ({ tasks: [], failures: [{ reason: "CAPACITY" }] });
    const dispatch = makeFargateDispatcher({ runTaskImpl: failing, env: REQUIRED_ENV });
    await expect(dispatch("run-1", {}, billing)).rejects.toThrow(/CAPACITY/);
  });

  it("throws when RunTask returns no tasks", async () => {
    const empty: RunTaskImpl = async () => ({ tasks: [], failures: [] });
    const dispatch = makeFargateDispatcher({ runTaskImpl: empty, env: REQUIRED_ENV });
    await expect(dispatch("run-1", {}, billing)).rejects.toThrow(/did not start/);
  });
});
