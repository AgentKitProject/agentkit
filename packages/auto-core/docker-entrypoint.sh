#!/bin/sh
# AgentKitAuto worker entrypoint (Phase D — hardened container isolation).
#
# The hosted Fargate task runs with a READ-ONLY root filesystem and ALL Linux
# capabilities dropped. The only writable path is the "scratch" ephemeral volume
# mounted at /scratch, which Fargate mounts ROOT-owned. The worker process runs
# as the non-root `node` user (uid 1000), so it cannot write to that root-owned
# mount as-is.
#
# This script runs as ROOT (PID 1), prepares /scratch so `node` can write to it,
# then drops privileges and EXECs the worker as `node` via `gosu`. After the
# exec, the long-lived worker process is non-root — only this short prep step is
# root. `exec` replaces PID 1 so signals (SIGTERM on task stop) reach node.
#
# AUTO_WORKSPACE_DIR (set by the CDK task def to /scratch/agentkitauto-workspaces)
# tells auto-core where to root per-run workspaces. We pre-create + chown that
# whole subtree so FsWorkspaceStore can create per-run workspace dirs under it.
#
# Robustness: if /scratch does not exist (e.g. self-host / local docker run with
# no volume mounted), we skip the chown and just drop to node — auto-core then
# falls back to its os.tmpdir() default when AUTO_WORKSPACE_DIR is unset. This
# keeps the image runnable outside the hardened Fargate task def.
#
# TWO container-security models share this image:
#   - Fargate: starts as ROOT, mounts /scratch root-owned. We must chown /scratch
#     to `node` (uid 1000), then drop to node via gosu.
#   - Kubernetes (self-host + hosted DOKS): the Job pod sets runAsNonRoot:true,
#     runAsUser:1000, capabilities.drop:[ALL], and `fsGroup:1000` so the kubelet
#     makes the /scratch emptyDir GROUP-writable by node — NO chown is needed (and
#     a non-root `chown -R` would EPERM and, under `set -e`, abort the whole
#     entrypoint before the worker ever starts). So we run the chown ONLY when we
#     are actually root; otherwise we trust fsGroup and skip straight to the worker.
set -eu

SCRATCH_ROOT="/scratch"
WORKSPACE_DIR="${AUTO_WORKSPACE_DIR:-}"

if [ -d "$SCRATCH_ROOT" ]; then
  # Create the workspace subtree (if AUTO_WORKSPACE_DIR points under /scratch) so
  # FsWorkspaceStore can make per-run dirs under it. mkdir -p is safe for both
  # models (root, or node under a group-writable mount).
  if [ -n "$WORKSPACE_DIR" ]; then
    mkdir -p "$WORKSPACE_DIR"
  fi
  # Root-only: hand the whole scratch mount to the non-root worker user. Under k8s
  # (non-root + fsGroup) this is skipped — the mount is already group-writable.
  if [ "$(id -u)" = "0" ]; then
    chown -R node:node "$SCRATCH_ROOT"
  fi
fi

# Drop to the non-root `node` user for the actual worker process. When already
# running as a non-root user (k8s runAsUser), `gosu node` would attempt a setuid
# the dropped-capabilities pod can't perform, so only re-exec via gosu when root.
if [ "$(id -u)" = "0" ]; then
  exec gosu node "$@"
fi
exec "$@"
