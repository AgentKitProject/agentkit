// KubeJobDispatcher unit tests — assert the V1Job spec without a real cluster.
//
// We inject a fake KubeJobsApi so no @kubernetes/client-node config is loaded and
// we can capture the exact Job the dispatcher builds (mirrors the Fargate test).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAutoJob,
  makeKubeJobDispatcher,
  type KubeJob,
  type KubeJobsApi,
} from "@/server/core/auto-kube-dispatcher";

const REQUIRED_ENV: Record<string, string | undefined> = {
  AUTO_K8S_WORKER_IMAGE: "ghcr.io/agentkitproject/agentkitauto-worker:v1",
  AUTO_K8S_NAMESPACE: "forge",
  DATABASE_URL: "postgresql://u:p@db:5432/agentkitforge_web",
  S3_ENDPOINT: "http://minio:9000",
  S3_BUCKET: "agentkitforge-web",
  S3_ACCESS_KEY_ID: "minioadmin",
  S3_SECRET_ACCESS_KEY: "supersecret",
  WEB_FORGE_INTERNAL_URL: "http://web:3000",
  AUTO_WORKER_SERVICE_KEY: "service-key-xyz",
  ANTHROPIC_API_KEY: "sk-ant-managed",
};

const billing = { inferenceMode: "byo", isCloudRun: false, cloudRunCentsPerMin: 0 } as never;

describe("kubeJobDispatcher", () => {
  let captured: { namespace: string; body: KubeJob } | null;
  let jobsApi: KubeJobsApi;

  beforeEach(() => {
    captured = null;
    jobsApi = {
      createNamespacedJob: vi.fn(async (namespace: string, body: KubeJob) => {
        captured = { namespace, body };
        return { metadata: { name: body.metadata.name } };
      }),
    };
  });

  afterEach(() => vi.restoreAllMocks());

  it("creates a hardened Job in the configured namespace with the self-host worker env", async () => {
    const dispatch = makeKubeJobDispatcher({ jobsApi, env: REQUIRED_ENV });
    await dispatch("run-42", {}, billing);

    expect(jobsApi.createNamespacedJob).toHaveBeenCalledTimes(1);
    const { namespace, body } = captured!;
    expect(namespace).toBe("forge");
    expect(body.apiVersion).toBe("batch/v1");
    expect(body.kind).toBe("Job");
    expect(body.metadata.namespace).toBe("forge");
    expect(body.metadata.name).toMatch(/^auto-run-run-42-[a-z0-9]+$/);

    const spec = body.spec as Record<string, any>;
    // Terminal run: no retries, restartPolicy Never, a TTL for auto-cleanup.
    expect(spec.backoffLimit).toBe(0);
    expect(spec.ttlSecondsAfterFinished).toBe(3600);
    const podSpec = spec.template.spec;
    expect(podSpec.restartPolicy).toBe("Never");

    // Pod-level hardening + fsGroup (so node writes the emptyDir without chown).
    expect(podSpec.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
    });

    const container = podSpec.containers[0];
    expect(container.image).toBe("ghcr.io/agentkitproject/agentkitauto-worker:v1");
    // Container-level hardening mirrors the Fargate task def.
    expect(container.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      runAsUser: 1000,
      capabilities: { drop: ["ALL"] },
    });
    // No capabilities.add — fsGroup handles /scratch writability.
    expect(container.securityContext.capabilities.add).toBeUndefined();

    // /scratch emptyDir is the single writable path under the read-only rootfs.
    expect(container.volumeMounts).toEqual([{ name: "scratch", mountPath: "/scratch" }]);
    expect(podSpec.volumes[0].name).toBe("scratch");
    expect(podSpec.volumes[0].emptyDir).toBeDefined();

    // Worker env: RUN_ID + the self-host backend + resolve config flow through.
    const env = container.env as { name: string; value: string }[];
    const envMap = Object.fromEntries(env.map((e) => [e.name, e.value]));
    expect(envMap.RUN_ID).toBe("run-42");
    expect(envMap.AUTO_BACKEND).toBe("selfhost");
    expect(envMap.KITSTORE_BACKEND).toBe("selfhost");
    expect(envMap.DATABASE_URL).toBe(REQUIRED_ENV.DATABASE_URL);
    expect(envMap.S3_ENDPOINT).toBe("http://minio:9000");
    expect(envMap.WEB_FORGE_INTERNAL_URL).toBe("http://web:3000");
    expect(envMap.AUTO_WORKER_SERVICE_KEY).toBe("service-key-xyz");
    // Workspace dir points under the writable scratch mount.
    expect(envMap.AUTO_WORKSPACE_DIR).toBe("/scratch/agentkitauto-workspaces");
  });

  it("never places the bearer token or a BYO key into the Job env", async () => {
    const dispatch = makeKubeJobDispatcher({ jobsApi, env: REQUIRED_ENV });
    // Pass a bearer in the kit-context opts; it must NOT leak into the Job.
    await dispatch("run-1", { bearerToken: "leak-me" } as never, billing);
    const serialized = JSON.stringify(captured!.body);
    expect(serialized).not.toContain("leak-me");
    expect(serialized).not.toContain("byo");
  });

  it("honors AUTO_K8S_* resource + TTL overrides and a service account", async () => {
    const dispatch = makeKubeJobDispatcher({
      jobsApi,
      env: {
        ...REQUIRED_ENV,
        AUTO_K8S_CPU_LIMIT: "2",
        AUTO_K8S_MEMORY_LIMIT: "2Gi",
        AUTO_K8S_TTL_SECONDS: "120",
        AUTO_K8S_SERVICE_ACCOUNT: "auto-worker-sa",
      },
    });
    await dispatch("run-1", {}, billing);
    const spec = captured!.body.spec as Record<string, any>;
    expect(spec.ttlSecondsAfterFinished).toBe(120);
    expect(spec.template.spec.serviceAccountName).toBe("auto-worker-sa");
    const limits = spec.template.spec.containers[0].resources.limits;
    expect(limits).toEqual({ cpu: "2", memory: "2Gi" });
  });

  it("throws when the required worker image env is missing", async () => {
    const dispatch = makeKubeJobDispatcher({
      jobsApi,
      env: { ...REQUIRED_ENV, AUTO_K8S_WORKER_IMAGE: undefined },
    });
    await expect(dispatch("run-1", {}, billing)).rejects.toThrow(/AUTO_K8S_WORKER_IMAGE/);
    expect(jobsApi.createNamespacedJob).not.toHaveBeenCalled();
  });

  it("wraps a Job-creation failure with a clear error", async () => {
    const failing: KubeJobsApi = {
      createNamespacedJob: async () => {
        throw new Error("Forbidden: cannot create jobs");
      },
    };
    const dispatch = makeKubeJobDispatcher({ jobsApi: failing, env: REQUIRED_ENV });
    await expect(dispatch("run-1", {}, billing)).rejects.toThrow(/Forbidden/);
  });

  it("buildAutoJob produces a DNS-1123-safe name from an awkward run id", () => {
    const job = buildAutoJob(
      "RUN_With/Weird:Chars",
      // minimal config
      {
        namespace: "ns",
        image: "img",
        cpuRequest: "250m",
        cpuLimit: "1",
        memoryRequest: "512Mi",
        memoryLimit: "1Gi",
        ttlSecondsAfterFinished: 3600,
        backoffLimit: 0,
        scratchSizeLimit: "1Gi",
        nodeUid: 1000,
      } as never,
      REQUIRED_ENV,
    );
    expect(job.metadata.name).toMatch(/^[a-z0-9-]+$/);
    expect(job.metadata.name.length).toBeLessThanOrEqual(63);
  });
});
