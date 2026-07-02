// Fargate dispatcher for AgentKitAuto — HOSTED long-running execution.
//
// This is the deferred-no-longer hosted dispatcher referenced in
// server/core/auto.ts's inProcessDispatcher note: Amplify SSR functions cannot
// host a long autonomous run, so on hosted deploys we hand the run off to an ECS
// Fargate task. The task (a separate worker image, built/deployed by CDK) boots,
// reads its RUN_ID from the container environment, and re-fetches everything it
// needs (system prompt, tools, billing/BYO config) from the web app's internal
// resolve-context endpoint using its own service key.
//
// SECURITY: we deliberately pass ONLY the RUN_ID into the task environment. The
// bearer token and the resolved billing/BYO key are NEVER placed in the task env
// (env is visible in the ECS console / task metadata). The worker re-fetches
// context over the service-key-authenticated internal endpoint instead.
//
// The module is dependency-light and unit-testable: makeFargateDispatcher accepts
// an injectable ECS client (or a runTaskImpl) and env map so a test can assert the
// RunTask parameters without touching real AWS.

import { awsClientEnv } from "@/server/aws-client";
import type { AutoDispatcher } from "@/server/core/auto";
import type { ECSClient, RunTaskCommandInput } from "@aws-sdk/client-ecs";

/** The container name in the CDK task definition that runs the auto worker.
 *  Overridable via AUTO_ECS_CONTAINER_NAME; the override MUST match the name the
 *  task def declares for its worker container. Default: "auto-worker". */
const DEFAULT_CONTAINER_NAME = "auto-worker";

/** The shape of a RunTask call we depend on — narrowed so a fake can implement it
 *  without pulling the full ECS client surface into tests. */
export interface RunTaskResult {
  tasks?: { taskArn?: string }[];
  failures?: { arn?: string; reason?: string; detail?: string }[];
}
export type RunTaskImpl = (input: RunTaskCommandInput) => Promise<RunTaskResult>;

/** Resolved Fargate launch configuration read from the environment. */
interface FargateConfig {
  cluster: string;
  taskDefinition: string;
  subnets: string[];
  securityGroupId: string;
  containerName: string;
}

/** Reads + validates the ECS launch config from env. Throws a clear Error listing
 *  every missing required variable (the run was already created queued; a throw
 *  propagates back through startRun so a MISCONFIGURED hosted deploy fails loudly
 *  rather than silently never running the job). */
function readFargateConfig(env: Record<string, string | undefined>): FargateConfig {
  const cluster = env.AUTO_ECS_CLUSTER?.trim();
  const taskDefinition = env.AUTO_ECS_TASK_DEF?.trim();
  const subnetsRaw = env.AUTO_ECS_SUBNET_IDS?.trim();
  const securityGroupId = env.AUTO_ECS_SECURITY_GROUP_ID?.trim();

  const subnets = (subnetsRaw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const missing: string[] = [];
  if (!cluster) missing.push("AUTO_ECS_CLUSTER");
  if (!taskDefinition) missing.push("AUTO_ECS_TASK_DEF");
  if (subnets.length === 0) missing.push("AUTO_ECS_SUBNET_IDS");
  if (!securityGroupId) missing.push("AUTO_ECS_SECURITY_GROUP_ID");
  if (missing.length > 0) {
    throw new Error(
      `Fargate Auto dispatcher is misconfigured: missing required env ${missing.join(", ")}.`
    );
  }

  return {
    cluster: cluster!,
    taskDefinition: taskDefinition!,
    subnets,
    securityGroupId: securityGroupId!,
    containerName: env.AUTO_ECS_CONTAINER_NAME?.trim() || DEFAULT_CONTAINER_NAME
  };
}

export interface MakeFargateDispatcherOptions {
  /** Inject a constructed ECS client (tests). When omitted one is built from
   *  awsClientEnv() (same creds source as the rest of the app). Ignored if
   *  runTaskImpl is supplied. */
  ecsClient?: ECSClient;
  /** Inject a raw RunTask implementation (tests). Takes precedence over
   *  ecsClient — lets a test assert the exact RunTaskCommandInput. */
  runTaskImpl?: RunTaskImpl;
  /** Override the env source (tests). Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/**
 * Build a Fargate AutoDispatcher. On dispatch it launches one FARGATE task from
 * the configured task definition, injecting ONLY RUN_ID into the worker
 * container's environment. Billing + bearer are intentionally NOT passed (the
 * worker re-fetches context via the service-key internal endpoint).
 */
export function makeFargateDispatcher(opts: MakeFargateDispatcherOptions = {}): AutoDispatcher {
  const env = opts.env ?? process.env;

  // Resolve a RunTask implementation. Prefer an injected impl; else an injected
  // client; else build a client lazily on first dispatch from awsClientEnv().
  let runTask: RunTaskImpl | null = opts.runTaskImpl ?? null;
  let client: ECSClient | null = opts.ecsClient ?? null;

  async function send(input: RunTaskCommandInput): Promise<RunTaskResult> {
    if (runTask) return runTask(input);
    // DYNAMIC import — @aws-sdk/client-ecs is only loaded on a real dispatch (the
    // Fargate code path is the sole consumer). This keeps the module importable
    // for self-host/local/dev/test builds where the ECS client may be absent or
    // where a fake runTaskImpl is injected, mirroring the lazy-import discipline
    // used elsewhere (getAutoStorage's dynamic auto-core import).
    const { ECSClient, RunTaskCommand } = await import("@aws-sdk/client-ecs");
    if (!client) {
      const aws = awsClientEnv();
      client = new ECSClient({
        region: aws.region,
        ...(aws.credentials ? { credentials: aws.credentials } : {})
      });
    }
    return (await client.send(new RunTaskCommand(input))) as RunTaskResult;
  }

  return async (runId: string): Promise<void> => {
    const cfg = readFargateConfig(env);

    const input: RunTaskCommandInput = {
      cluster: cfg.cluster,
      taskDefinition: cfg.taskDefinition,
      launchType: "FARGATE",
      count: 1,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: cfg.subnets,
          securityGroups: [cfg.securityGroupId],
          assignPublicIp: "ENABLED"
        }
      },
      overrides: {
        containerOverrides: [
          {
            name: cfg.containerName,
            // ONLY the run id — never the bearer token or billing/BYO key.
            environment: [{ name: "RUN_ID", value: runId }]
          }
        ]
      }
    };

    const result = await send(input);

    const failures = result.failures ?? [];
    if (failures.length > 0) {
      const reason = failures
        .map((f) => f.reason ?? f.detail ?? "unknown")
        .join("; ");
      throw new Error(`Fargate RunTask failed to launch the Auto worker: ${reason}`);
    }
    if (!result.tasks || result.tasks.length === 0) {
      throw new Error("Fargate RunTask returned no tasks; the Auto worker did not start.");
    }
    // Do NOT log task ARNs at info level with secrets — only the run id is safe.
    // eslint-disable-next-line no-console
    console.info(`[auto] dispatched run ${runId} to Fargate (${result.tasks.length} task)`);
  };
}

/** The default Fargate dispatcher, built from process.env / awsClientEnv(). */
export const fargateDispatcher: AutoDispatcher = makeFargateDispatcher();
