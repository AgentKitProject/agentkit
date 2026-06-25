/**
 * k8s Job dispatcher — the HOSTED-DOKS + self-host run-execution dispatch path.
 *
 * Asserts (with an INJECTED Jobs API + env map — NO real cluster, NO k8s client
 * import) that the dispatcher builds a correct, hardened batch/v1 Job for a run:
 *   - the worker image, namespace, and per-run RUN_ID are set;
 *   - the worker env carries the selfhost backend + resolve endpoint + service key
 *     + Anthropic key + the S3 / inputs-bucket config the worker needs, but NEVER a
 *     bearer token or a BYO API key (those are re-fetched over the service key);
 *   - the securityContext is hardened (non-root, read-only rootfs, dropped caps)
 *     and a /scratch emptyDir is the only writable mount;
 *   - a missing AUTO_K8S_WORKER_IMAGE fails loudly (the run was already queued).
 */

import { describe, expect, it } from "vitest";
import {
  buildAutoJob,
  makeKubeJobDispatcher,
  type KubeJob,
  type KubeJobsApi,
} from "@/server/core/auto-kube-dispatcher";

/** A representative HOSTED-DOKS web-pod env (selfhost backend + managed billing). */
const DOKS_ENV: Record<string, string | undefined> = {
  AUTO_K8S_WORKER_IMAGE: "ghcr.io/agentkitproject/agentkitauto-worker:sha-abc",
  AUTO_K8S_NAMESPACE: "agentkit",
  AUTO_SELFHOST_BILLING: "managed",
  DATABASE_URL: "postgresql://u:p@pg:5432/agentkitauto",
  S3_ENDPOINT: "https://nyc3.digitaloceanspaces.com",
  S3_BUCKET: "agentkit-kit-trees",
  S3_ACCESS_KEY_ID: "AKIA_EXAMPLE",
  S3_SECRET_ACCESS_KEY: "secret-should-be-forwarded-but-not-bearer",
  AWS_REGION: "nyc3",
  S3_FORCE_PATH_STYLE: "false",
  WEB_FORGE_INTERNAL_URL: "http://agentkitauto-web",
  AUTO_WORKER_SERVICE_KEY: "svc-key-123",
  ANTHROPIC_API_KEY: "sk-ant-REDACTED",
};

function envValue(job: KubeJob, name: string): string | undefined {
  const container = (job.spec as any).template.spec.containers[0];
  const found = (container.env as { name: string; value: string }[]).find((e) => e.name === name);
  return found?.value;
}

/** The AutoDispatcher signature is (runId, opts, billing); the k8s/Fargate
 *  dispatchers ignore opts + billing (the worker re-resolves both over the service
 *  key), so the tests pass empty stubs to satisfy the type. */
const OPTS = {} as never;
const BILLING = { inferenceMode: "managed", isCloudRun: true, cloudRunCentsPerMin: 1 } as never;

describe("buildAutoJob (k8s Job spec for an Auto run)", () => {
  it("sets image, namespace, RUN_ID, and selfhost backend", () => {
    const job = buildAutoJob(
      "run-xyz",
      {
        namespace: "agentkit",
        image: DOKS_ENV.AUTO_K8S_WORKER_IMAGE!,
        cpuRequest: "250m",
        cpuLimit: "1",
        memoryRequest: "512Mi",
        memoryLimit: "1Gi",
        ttlSecondsAfterFinished: 3600,
        backoffLimit: 0,
        scratchSizeLimit: "1Gi",
        nodeUid: 1000,
      },
      DOKS_ENV,
    );

    expect(job.apiVersion).toBe("batch/v1");
    expect(job.kind).toBe("Job");
    expect(job.metadata.namespace).toBe("agentkit");
    const container = (job.spec as any).template.spec.containers[0];
    expect(container.image).toBe(DOKS_ENV.AUTO_K8S_WORKER_IMAGE);
    expect(envValue(job, "RUN_ID")).toBe("run-xyz");
    expect(envValue(job, "AUTO_BACKEND")).toBe("selfhost");
    expect(envValue(job, "KITSTORE_BACKEND")).toBe("selfhost");
  });

  it("forwards backend + resolve + billing env (incl. inputs bucket + path style)", () => {
    const job = buildAutoJob(
      "run-1",
      {
        namespace: "agentkit",
        image: "img",
        cpuRequest: "250m",
        cpuLimit: "1",
        memoryRequest: "512Mi",
        memoryLimit: "1Gi",
        ttlSecondsAfterFinished: 3600,
        backoffLimit: 0,
        scratchSizeLimit: "1Gi",
        nodeUid: 1000,
      },
      DOKS_ENV,
    );

    expect(envValue(job, "DATABASE_URL")).toBe(DOKS_ENV.DATABASE_URL);
    expect(envValue(job, "S3_BUCKET")).toBe("agentkit-kit-trees");
    expect(envValue(job, "WEB_FORGE_INTERNAL_URL")).toBe("http://agentkitauto-web");
    expect(envValue(job, "AUTO_WORKER_SERVICE_KEY")).toBe("svc-key-123");
    expect(envValue(job, "ANTHROPIC_API_KEY")).toBe("sk-ant-REDACTED");
    expect(envValue(job, "AUTO_SELFHOST_BILLING")).toBe("managed");
    // Increment I4: Phase-C input hydration config forwarded to the worker.
    expect(envValue(job, "AUTO_INPUTS_BUCKET")).toBe("agentkit-kit-trees");
    expect(envValue(job, "S3_FORCE_PATH_STYLE")).toBe("false");
  });

  it("NEVER forwards a bearer token or BYO key into the Job env", () => {
    const env = { ...DOKS_ENV, AUTO_BEARER_TOKEN: "leak-me", BYO_API_KEY: "leak-me-too" };
    const job = buildAutoJob(
      "run-1",
      {
        namespace: "agentkit",
        image: "img",
        cpuRequest: "250m",
        cpuLimit: "1",
        memoryRequest: "512Mi",
        memoryLimit: "1Gi",
        ttlSecondsAfterFinished: 3600,
        backoffLimit: 0,
        scratchSizeLimit: "1Gi",
        nodeUid: 1000,
      },
      env,
    );
    const container = (job.spec as any).template.spec.containers[0];
    const names = (container.env as { name: string }[]).map((e) => e.name);
    expect(names).not.toContain("AUTO_BEARER_TOKEN");
    expect(names).not.toContain("BYO_API_KEY");
  });

  it("hardens the container: non-root, read-only rootfs, dropped caps, scratch emptyDir", () => {
    const job = buildAutoJob(
      "run-1",
      {
        namespace: "agentkit",
        image: "img",
        cpuRequest: "250m",
        cpuLimit: "1",
        memoryRequest: "512Mi",
        memoryLimit: "1Gi",
        ttlSecondsAfterFinished: 3600,
        backoffLimit: 0,
        scratchSizeLimit: "1Gi",
        nodeUid: 1000,
      },
      DOKS_ENV,
    );
    const podSpec = (job.spec as any).template.spec;
    expect(podSpec.restartPolicy).toBe("Never");
    expect(podSpec.securityContext.runAsNonRoot).toBe(true);
    expect(podSpec.securityContext.runAsUser).toBe(1000);
    expect(podSpec.securityContext.fsGroup).toBe(1000);
    const c = podSpec.containers[0];
    expect(c.securityContext.readOnlyRootFilesystem).toBe(true);
    expect(c.securityContext.allowPrivilegeEscalation).toBe(false);
    expect(c.securityContext.capabilities.drop).toContain("ALL");
    expect(c.volumeMounts[0].mountPath).toBe("/scratch");
    expect(podSpec.volumes[0].emptyDir).toBeDefined();
    expect((job.spec as any).backoffLimit).toBe(0);
    expect((job.spec as any).ttlSecondsAfterFinished).toBe(3600);
  });
});

describe("makeKubeJobDispatcher", () => {
  it("creates exactly one Job in the configured namespace on dispatch", async () => {
    const created: { namespace: string; body: KubeJob }[] = [];
    const jobsApi: KubeJobsApi = {
      async createNamespacedJob(namespace, body) {
        created.push({ namespace, body });
        return {};
      },
    };
    const dispatch = makeKubeJobDispatcher({ jobsApi, env: DOKS_ENV });

    await dispatch("run-7", OPTS, BILLING);

    expect(created).toHaveLength(1);
    expect(created[0].namespace).toBe("agentkit");
    expect(created[0].body.metadata.namespace).toBe("agentkit");
    const container = (created[0].body.spec as any).template.spec.containers[0];
    const runId = (container.env as { name: string; value: string }[]).find((e) => e.name === "RUN_ID");
    expect(runId?.value).toBe("run-7");
  });

  it("fails loudly when AUTO_K8S_WORKER_IMAGE is missing (run already queued)", async () => {
    const jobsApi: KubeJobsApi = {
      async createNamespacedJob() {
        return {};
      },
    };
    const dispatch = makeKubeJobDispatcher({ jobsApi, env: { AUTO_K8S_NAMESPACE: "agentkit" } });
    await expect(dispatch("run-1", OPTS, BILLING)).rejects.toThrow(/AUTO_K8S_WORKER_IMAGE/);
  });

  it("wraps a cluster create failure in a clear error", async () => {
    const jobsApi: KubeJobsApi = {
      async createNamespacedJob() {
        throw new Error("forbidden: cannot create jobs");
      },
    };
    const dispatch = makeKubeJobDispatcher({ jobsApi, env: DOKS_ENV });
    await expect(dispatch("run-1", OPTS, BILLING)).rejects.toThrow(/Kubernetes failed to create the Auto worker Job/);
  });
});
