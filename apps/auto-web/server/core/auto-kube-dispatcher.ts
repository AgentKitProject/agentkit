// Kubernetes Job-per-run dispatcher for AgentKitAuto — SELF-HOST long-running
// execution.
//
// This is the self-host equivalent of the hosted Fargate dispatcher
// (auto-fargate-dispatcher.ts). On a self-hosted k8s deployment, an Auto run
// cannot execute in-process on the web pod (it would be killed when the request
// handler returns, and a long run shouldn't occupy a web replica), so we hand it
// off to a one-shot Kubernetes Job that runs the SAME worker image as Fargate.
//
// HOW IT DIFFERS FROM FARGATE
//   - Fargate hands off to a PRE-BAKED ECS task definition (CDK owns the image,
//     env, resources, and securityContext); the dispatcher only injects RUN_ID.
//   - k8s self-host has no pre-baked task def, so THIS dispatcher builds the full
//     Job spec at dispatch time: image, namespace, env (storage/billing/resolve),
//     resources, TTL, and the hardened securityContext. The config comes from env
//     vars (AUTO_K8S_*), the same way the Fargate dispatcher reads AUTO_ECS_*.
//
// SECURITY (mirrors Fargate)
//   - The bearer token and the resolved billing/BYO key are NEVER placed in the
//     Job env. The worker re-fetches context over the service-key-authenticated
//     internal resolve endpoint (WEB_FORGE_INTERNAL_URL + AUTO_WORKER_SERVICE_KEY).
//   - Container hardening translated from the Fargate task def to k8s
//     securityContext: runAsNonRoot + runAsUser(node uid 1000), fsGroup(1000),
//     readOnlyRootFilesystem, allowPrivilegeEscalation:false, capabilities.drop
//     [ALL]. The worker entrypoint chowns a scratch dir when it can, but under
//     k8s we instead mount an `emptyDir` at /scratch and set `fsGroup: 1000` so
//     the kubelet group-owns the volume to the node user — node can write WITHOUT
//     any chown, so we do NOT need to grant CHOWN/SETUID/SETGID back. This is the
//     cleaner k8s approach (no capabilities.add), and the worker entrypoint
//     already no-ops its chown gracefully when /scratch is group-writable / when
//     it isn't running as root. AUTO_WORKSPACE_DIR points workspaces under
//     /scratch so the read-only root filesystem is never written.
//
// The module is dependency-light and unit-testable: makeKubeJobDispatcher accepts
// an injectable Jobs API (a narrow `createNamespacedJob` surface) and env map so a
// test can assert the V1Job spec without a real cluster. `@kubernetes/client-node`
// is lazy-imported only on a real dispatch (it must not bloat the hosted build).

import type { AutoDispatcher } from "@/server/core/auto";

/** The narrow Kubernetes Jobs surface the dispatcher depends on — just enough to
 *  create a Job. A fake can implement this without the full BatchV1Api. The real
 *  `@kubernetes/client-node` BatchV1Api.createNamespacedJob(namespace, body)
 *  satisfies it structurally. */
export interface KubeJobsApi {
  createNamespacedJob(namespace: string, body: KubeJob): Promise<unknown>;
}

/** A minimal structural V1Job shape (we build a plain object; the real client
 *  validates server-side). Kept local so tests don't import the k8s types. */
export interface KubeJob {
  apiVersion: "batch/v1";
  kind: "Job";
  metadata: { name: string; namespace: string; labels?: Record<string, string> };
  spec: Record<string, unknown>;
}

/** Resolved k8s launch configuration read from the environment. */
interface KubeConfigEnv {
  namespace: string;
  image: string;
  serviceAccountName?: string;
  cpuRequest: string;
  cpuLimit: string;
  memoryRequest: string;
  memoryLimit: string;
  ttlSecondsAfterFinished: number;
  backoffLimit: number;
  scratchSizeLimit: string;
  nodeUid: number;
}

const DEFAULT_NAMESPACE = "default";
const DEFAULT_SCRATCH_PATH = "/scratch";
const DEFAULT_WORKSPACE_DIR = "/scratch/agentkitauto-workspaces";
/** The `node` user uid in the worker image (node:22-slim) — same as Fargate. */
const NODE_UID = 1000;

/** Reads + validates the k8s launch config from env. Throws a clear Error listing
 *  every missing required variable (the run was already created queued; a throw
 *  propagates back through startRun so a misconfigured self-host deploy fails
 *  loudly rather than silently never running the job). Mirrors readFargateConfig. */
function readKubeConfig(env: Record<string, string | undefined>): KubeConfigEnv {
  const namespace = env.AUTO_K8S_NAMESPACE?.trim() || DEFAULT_NAMESPACE;
  const image = env.AUTO_K8S_WORKER_IMAGE?.trim();

  const missing: string[] = [];
  if (!image) missing.push("AUTO_K8S_WORKER_IMAGE");
  if (missing.length > 0) {
    throw new Error(
      `Kubernetes Auto dispatcher is misconfigured: missing required env ${missing.join(", ")}.`,
    );
  }

  const num = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined || raw.trim() === "") return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  };

  return {
    namespace,
    image: image!,
    ...(env.AUTO_K8S_SERVICE_ACCOUNT?.trim()
      ? { serviceAccountName: env.AUTO_K8S_SERVICE_ACCOUNT.trim() }
      : {}),
    cpuRequest: env.AUTO_K8S_CPU_REQUEST?.trim() || "250m",
    cpuLimit: env.AUTO_K8S_CPU_LIMIT?.trim() || "1",
    memoryRequest: env.AUTO_K8S_MEMORY_REQUEST?.trim() || "512Mi",
    memoryLimit: env.AUTO_K8S_MEMORY_LIMIT?.trim() || "1Gi",
    // Auto-cleanup finished Jobs (default 1h) so the namespace doesn't fill up.
    ttlSecondsAfterFinished: num(env.AUTO_K8S_TTL_SECONDS, 3600),
    // No retries: a failed Auto run is terminal (the run record holds the error).
    backoffLimit: num(env.AUTO_K8S_BACKOFF_LIMIT, 0),
    scratchSizeLimit: env.AUTO_K8S_SCRATCH_SIZE?.trim() || "1Gi",
    nodeUid: num(env.AUTO_K8S_RUN_AS_USER, NODE_UID),
  };
}

/** The worker-container env the Job injects. This is the per-Job env the worker
 *  reads on boot. It carries NO bearer token and NO BYO key (those are re-fetched
 *  over the service-key resolve endpoint). It DOES carry the self-host backend
 *  config (DATABASE_URL, S3/MinIO, table/schema config), the resolve endpoint +
 *  service key, ANTHROPIC_API_KEY (for managed billing if enabled), the workspace
 *  dir, and the billing markup/policy knobs — read from the web pod's own env so
 *  the operator configures them once (via the chart) and they flow to each Job. */
function workerEnv(
  runId: string,
  env: Record<string, string | undefined>,
): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  const put = (name: string, value: string | undefined): void => {
    if (value !== undefined && value !== "") out.push({ name, value });
  };

  // The run id — the only per-run value (mirrors Fargate's single override).
  put("RUN_ID", runId);

  // Backend selection: force the self-host worker path.
  put("AUTO_BACKEND", "selfhost");
  put("KITSTORE_BACKEND", "selfhost");

  // Self-host storage backend config (Postgres + MinIO/S3 + workspace dir).
  put("DATABASE_URL", env.DATABASE_URL);
  put("S3_ENDPOINT", env.S3_ENDPOINT);
  put("S3_BUCKET", env.S3_BUCKET);
  put("S3_PREFIX", env.S3_PREFIX);
  put("S3_ACCESS_KEY_ID", env.S3_ACCESS_KEY_ID);
  put("S3_SECRET_ACCESS_KEY", env.S3_SECRET_ACCESS_KEY);
  put("AWS_REGION", env.AWS_REGION);
  // Phase C staged input-file hydration reads from AUTO_INPUTS_BUCKET (falling
  // back to S3_BUCKET in auto-core's adapter). Forward both it and the
  // path-style flag so a worker Job hydrates uploaded inputs from the SAME
  // bucket the web app presigned them into; without this, runs that carry
  // `inputFiles` silently skip hydration on the worker.
  put("AUTO_INPUTS_BUCKET", env.AUTO_INPUTS_BUCKET || env.S3_BUCKET);
  put("S3_FORCE_PATH_STYLE", env.S3_FORCE_PATH_STYLE);
  // Workspace dir under the writable scratch emptyDir (read-only root fs).
  put("AUTO_WORKSPACE_DIR", env.AUTO_WORKSPACE_DIR || DEFAULT_WORKSPACE_DIR);

  // Resolve endpoint + service key (the worker re-fetches kit context here).
  put("WEB_FORGE_INTERNAL_URL", env.WEB_FORGE_INTERNAL_URL);
  put("AUTO_WORKER_SERVICE_KEY", env.AUTO_WORKER_SERVICE_KEY);

  // Inference: ANTHROPIC_API_KEY (managed billing) + billing knobs.
  put("ANTHROPIC_API_KEY", env.ANTHROPIC_API_KEY);
  put("AUTO_MARKUP_BPS", env.AUTO_MARKUP_BPS);
  put("AUTO_CLOUD_RUN_CENTS_PER_MIN", env.AUTO_CLOUD_RUN_CENTS_PER_MIN);
  // Self-host billing policy: "free" (default; BYO, no metering) | "managed".
  put("AUTO_SELFHOST_BILLING", env.AUTO_SELFHOST_BILLING);

  // Optional run bounds (forwarded if the operator set them).
  put("AUTO_MAX_TOKENS", env.AUTO_MAX_TOKENS);
  put("AUTO_MAX_TOOL_ROUNDS", env.AUTO_MAX_TOOL_ROUNDS);

  // Email delivery: SMTP is deferred on self-host (the worker uses the no-op
  // self-host EmailSender); webhook delivery works regardless. Forwarded for
  // forward-compat if/when SMTP lands.
  put("SES_SENDER", env.SES_SENDER);

  return out;
}

/**
 * Build the V1Job spec for one Auto run. backoffLimit:0 + restartPolicy:Never
 * (a failed run is terminal), a TTL for auto-cleanup, resource requests/limits,
 * the hardened securityContext, and an emptyDir mounted at /scratch (the only
 * writable path under the read-only root filesystem; fsGroup lets node write it
 * without chown).
 */
export function buildAutoJob(
  runId: string,
  cfg: KubeConfigEnv,
  env: Record<string, string | undefined>,
): KubeJob {
  // A DNS-1123-safe, unique-ish job name. Run ids may contain characters not
  // valid in a k8s name, so we slugify and add a short suffix for uniqueness.
  const slug = runId.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 8);
  const name = `auto-run-${slug || "x"}-${suffix}`.slice(0, 63);

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name,
      namespace: cfg.namespace,
      labels: {
        "app.kubernetes.io/managed-by": "agentkitforge-web",
        "app.kubernetes.io/component": "auto-worker",
        "agentkitforge.dev/auto-run": slug || "x",
      },
    },
    spec: {
      backoffLimit: cfg.backoffLimit,
      ttlSecondsAfterFinished: cfg.ttlSecondsAfterFinished,
      template: {
        metadata: {
          labels: {
            "app.kubernetes.io/managed-by": "agentkitforge-web",
            "app.kubernetes.io/component": "auto-worker",
          },
        },
        spec: {
          restartPolicy: "Never",
          ...(cfg.serviceAccountName ? { serviceAccountName: cfg.serviceAccountName } : {}),
          // Pod-level hardening. fsGroup makes the emptyDir group-owned by the
          // node user so it can write /scratch with NO chown (hence no need to
          // add back CHOWN/SETUID/SETGID caps — the cleaner k8s approach).
          securityContext: {
            runAsNonRoot: true,
            runAsUser: cfg.nodeUid,
            runAsGroup: cfg.nodeUid,
            fsGroup: cfg.nodeUid,
          },
          containers: [
            {
              name: "auto-worker",
              image: cfg.image,
              env: workerEnv(runId, env),
              resources: {
                requests: { cpu: cfg.cpuRequest, memory: cfg.memoryRequest },
                limits: { cpu: cfg.cpuLimit, memory: cfg.memoryLimit },
              },
              // Container-level hardening (mirrors the Fargate task def).
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                runAsNonRoot: true,
                runAsUser: cfg.nodeUid,
                capabilities: { drop: ["ALL"] },
              },
              volumeMounts: [{ name: "scratch", mountPath: DEFAULT_SCRATCH_PATH }],
            },
          ],
          // The single writable path under the read-only root fs.
          volumes: [
            {
              name: "scratch",
              emptyDir: { sizeLimit: cfg.scratchSizeLimit },
            },
          ],
        },
      },
    },
  };
}

export interface MakeKubeJobDispatcherOptions {
  /** Inject a Jobs API (tests). When omitted, one is built lazily on first
   *  dispatch from the in-cluster KubeConfig. */
  jobsApi?: KubeJobsApi;
  /** Override the env source (tests). Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/**
 * Build a Kubernetes-Job AutoDispatcher. On dispatch it creates one batch/v1 Job
 * (the worker image) in the configured namespace, injecting the self-host backend
 * + resolve config into the worker env (never the bearer/BYO key). The Job is
 * hardened (non-root, read-only rootfs, dropped caps, /scratch emptyDir) and
 * self-cleaning (TTL).
 */
export function makeKubeJobDispatcher(opts: MakeKubeJobDispatcherOptions = {}): AutoDispatcher {
  const env = opts.env ?? process.env;
  let jobsApi: KubeJobsApi | null = opts.jobsApi ?? null;

  async function api(): Promise<KubeJobsApi> {
    if (jobsApi) return jobsApi;
    // DYNAMIC import — @kubernetes/client-node is only loaded on a real dispatch
    // (the self-host k8s path is its sole consumer), keeping it out of the hosted
    // build's hot import graph. Mirrors the Fargate dispatcher's lazy ECS import.
    const { KubeConfig, BatchV1Api } = await import("@kubernetes/client-node");
    const kc = new KubeConfig();
    kc.loadFromCluster();
    const batch = kc.makeApiClient(BatchV1Api);
    jobsApi = {
      createNamespacedJob: (namespace, body) =>
        // The generated client uses object-param requests; our KubeJob is a
        // structural subset of V1Job, so the cast is safe (server-side validates).
        batch.createNamespacedJob({ namespace, body: body as never }),
    };
    return jobsApi;
  }

  return async (runId: string): Promise<void> => {
    const cfg = readKubeConfig(env);
    const job = buildAutoJob(runId, cfg, env);
    const client = await api();
    try {
      await client.createNamespacedJob(cfg.namespace, job);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Kubernetes failed to create the Auto worker Job: ${message}`);
    }
    // Do NOT log env/secrets — only the run id + job name are safe.
    // eslint-disable-next-line no-console
    console.info(`[auto] dispatched run ${runId} to Kubernetes Job ${job.metadata.name}`);
  };
}

/** The default k8s Job dispatcher, built from process.env / in-cluster config. */
export const kubeJobDispatcher: AutoDispatcher = makeKubeJobDispatcher();
