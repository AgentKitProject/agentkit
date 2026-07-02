import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as logs from "aws-cdk-lib/aws-logs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as ses from "aws-cdk-lib/aws-ses";
import * as route53 from "aws-cdk-lib/aws-route53";

/**
 * Hosted (AWS) backing store for the agentkitforge `KitStore`/`UserSettingsStore`
 * AWS adapter (server/store/aws-*.ts). Provisions:
 *   - an S3 bucket for kit file trees    (S3_BUCKET)
 *   - a DynamoDB table for kit metadata  (DYNAMODB_KITS_TABLE; PK userId / SK kitId)
 *   - a DynamoDB table for user settings (DYNAMODB_SETTINGS_TABLE; PK userId)
 *
 * The web app reads these names from env when KITSTORE_BACKEND=aws. This stack
 * only creates the data stores; the Next.js app itself is hosted on Amplify
 * (separate), and its IAM principal must be granted access to these resources.
 */
export class AgentKitForgeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const kitTrees = new s3.Bucket(this, "KitTreesBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      // Retain on stack delete — kit content is user data, never auto-destroy.
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });

    const kitsTable = new dynamodb.Table(this, "KitsTable", {
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "kitId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });

    const settingsTable = new dynamodb.Table(this, "UserSettingsTable", {
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });

    // Env-var values for the web app (KITSTORE_BACKEND=aws).
    new cdk.CfnOutput(this, "S3Bucket", {
      value: kitTrees.bucketName,
      description: "S3_BUCKET"
    });
    new cdk.CfnOutput(this, "DynamoKitsTable", {
      value: kitsTable.tableName,
      description: "DYNAMODB_KITS_TABLE"
    });
    new cdk.CfnOutput(this, "DynamoSettingsTable", {
      value: settingsTable.tableName,
      description: "DYNAMODB_SETTINGS_TABLE"
    });

    // ========================================================================
    // AgentKitAuto — hosted execution infrastructure (Phase A)
    //
    // Provisions the cloud worker plane that runs Agent Kits on Fargate:
    //   - AutoRunsTable / AutoApprovalsTable (run state + approval grants)
    //   - an ECR repo for the worker image (agentkit-auto-worker)
    //   - a dedicated public-only VPC, a locked-down egress security group,
    //     a CloudWatch log group, an ECS cluster, and a Fargate task def
    //   - IAM exec/task roles (least-privilege) and grants to the out-of-band
    //     SSR IAM user so the web app's FargateDispatcher can RunTask.
    //
    // Out-of-band resources (created elsewhere in AWS, only REFERENCED here):
    //   - the scoped SSR IAM user `agentkitforge-ssr`
    //   - the Gateway credit ledger tables (Accounts/Txns/Holds)
    //
    // Synth-safe VPC decision: we deliberately do NOT use ec2.Vpc.fromLookup
    // (which performs a live environment lookup needing AWS creds and would
    // break `cdk synth` in CI). Instead we provision a small DEDICATED VPC with
    // ONLY public subnets and NO NAT gateways — this synthesizes with no creds,
    // gives the worker public-subnet egress (443 over an internet gateway via
    // public IP), and satisfies the "no NAT" rule. The original "use the
    // default VPC's public subnets" intent is preserved in spirit.
    // ========================================================================

    // Configurable names/values (context-overridable, sensible defaults).
    const ssrUserName: string =
      this.node.tryGetContext("ssrUserName") ?? "agentkitforge-ssr";
    const gatewayCreditAccountsName: string =
      this.node.tryGetContext("gatewayCreditAccountsTable") ?? "GatewayCreditAccounts";
    const gatewayCreditTxnsName: string =
      this.node.tryGetContext("gatewayCreditTxnsTable") ?? "GatewayCreditTxns";
    const gatewayCreditHoldsName: string =
      this.node.tryGetContext("gatewayCreditHoldsTable") ?? "GatewayCreditHolds";
    const gatewaySessionsName: string =
      this.node.tryGetContext("gatewaySessionsTable") ?? "GatewaySessions";
    const autoMarkupBps: string =
      this.node.tryGetContext("autoMarkupBps") ?? "0";
    const autoCloudRunCentsPerMin: string =
      this.node.tryGetContext("autoCloudRunCentsPerMin") ?? "0";
    const webForgeInternalUrl: string =
      this.node.tryGetContext("webForgeInternalUrl") ??
      "https://forge.agentkitproject.com";
    // Phase-A secrets pulled from context only (never hardcoded); see note below.
    const anthropicApiKey: string | undefined =
      this.node.tryGetContext("anthropicApiKey");
    const autoWorkerServiceKey: string | undefined =
      this.node.tryGetContext("autoWorkerServiceKey");

    // Phase D — result-delivery SES sender. The app sends completion
    // notifications from this verified-domain address (noreply@agentkitproject.com
    // by default; context-overridable). The sender's DOMAIN must be a verified SES
    // identity (created below) for SES to accept the send.
    const sesSender: string =
      this.node.tryGetContext("sesSender") ?? "noreply@agentkitproject.com";
    // The verified SES domain identity (the part after the @). Used both to create
    // the EmailIdentity and to scope the SendEmail grant's FromAddress condition.
    const sesDomain: string = sesSender.includes("@")
      ? sesSender.slice(sesSender.indexOf("@") + 1)
      : sesSender;
    // Escape hatch: if cross-zone DKIM record creation is undesirable in a given
    // environment, set context `sesAutoDkimRecords=false` to create the identity
    // WITHOUT the Route53 records and instead emit the records to add manually.
    const sesAutoDkimRecords: boolean =
      this.node.tryGetContext("sesAutoDkimRecords") !== "false";

    // ---- 1. DynamoDB tables --------------------------------------------------
    const autoRunsTable = new dynamodb.Table(this, "AutoRunsTable", {
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });
    autoRunsTable.addGlobalSecondaryIndex({
      indexName: "userId-index",
      partitionKey: { name: "gsiUserId", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL
    });

    const autoApprovalsTable = new dynamodb.Table(this, "AutoApprovalsTable", {
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });
    autoApprovalsTable.addGlobalSecondaryIndex({
      indexName: "userKitKey-index",
      partitionKey: { name: "gsiUserKitKey", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL
    });
    autoApprovalsTable.addGlobalSecondaryIndex({
      indexName: "userId-index",
      partitionKey: { name: "gsiUserId", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // AutoSchedules (Phase B) — standing cron schedules. Key schema MUST mirror
    // auto-core's aws adapter (src/adapters/aws DynamoAutoScheduleRepository):
    //   - PK `id`.
    //   - GSI `userId-index` (PK gsiUserId)        — listSchedulesByUser.
    //   - GSI `dueIndex`     (PK gsiDue, SK nextRunAt) — listDueSchedules: a single
    //     Query on gsiDue="1" (a constant partition present only on ENABLED rows)
    //     with KeyCondition nextRunAt <= now. Disabled schedules drop out of the
    //     index (adapter omits gsiDue), so the per-minute sweep scans no extra rows.
    const autoSchedulesTable = new dynamodb.Table(this, "AutoSchedulesTable", {
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });
    autoSchedulesTable.addGlobalSecondaryIndex({
      indexName: "userId-index",
      partitionKey: { name: "gsiUserId", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL
    });
    autoSchedulesTable.addGlobalSecondaryIndex({
      indexName: "dueIndex",
      partitionKey: { name: "gsiDue", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "nextRunAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // AutoWebhooks (Phase C) — standing inbound webhook triggers. Key schema MUST
    // mirror auto-core's aws adapter (DynamoAutoWebhookRepository):
    //   - PK `id`.
    //   - GSI `userId-index` (PK gsiUserId) — listWebhooksByUser.
    // Stores ONLY the secret HASH (never the plaintext); fireCount is incremented
    // atomically via an ADD on recordFire.
    const autoWebhooksTable = new dynamodb.Table(this, "AutoWebhooksTable", {
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });
    autoWebhooksTable.addGlobalSecondaryIndex({
      indexName: "userId-index",
      partitionKey: { name: "gsiUserId", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // Phase C: staged run-input files live under an `auto-inputs/` prefix in the
    // existing kit-trees bucket (auto-core's S3InputStore builds keys
    // `auto-inputs/{runId}/...`). The web app (SSR user) presigns PUT on this
    // prefix; the worker (task role) GETs them during hydration.
    const autoInputsPrefix = "auto-inputs/";

    // ---- 2. ECR repository ---------------------------------------------------
    const workerRepo = new ecr.Repository(this, "AutoWorkerRepo", {
      repositoryName: "agentkit-auto-worker",
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });
    workerRepo.addLifecycleRule({
      description: "Expire untagged images after 14 days",
      tagStatus: ecr.TagStatus.UNTAGGED,
      maxImageAge: cdk.Duration.days(14)
    });

    // ---- 3. Networking — dedicated public-only VPC, no NAT --------------------
    // Public subnets + internet gateway only; egress 443/DNS via public IP.
    const vpc = new ec2.Vpc(this, "AutoVpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }
      ]
    });

    const sg = new ec2.SecurityGroup(this, "AutoWorkerSg", {
      vpc,
      allowAllOutbound: false,
      description: "Auto worker egress: 443 + DNS only"
    });
    sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS egress");
    sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(53), "DNS (UDP)");
    sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(53), "DNS (TCP)");

    // ---- 4. CloudWatch log group ---------------------------------------------
    const logGroup = new logs.LogGroup(this, "AutoWorkerLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // ---- 5. ECS cluster + roles + task def -----------------------------------
    const cluster = new ecs.Cluster(this, "AutoCluster", { vpc });

    // Execution role: ECR pull + log writes (used by the awslogs driver).
    const executionRole = new iam.Role(this, "AutoTaskExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com")
    });
    executionRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "service-role/AmazonECSTaskExecutionRolePolicy"
      )
    );

    // Reference the out-of-band Gateway credit ledger tables (RW for the worker).
    const gatewayCreditAccounts = dynamodb.Table.fromTableName(
      this,
      "GatewayCreditAccountsTable",
      gatewayCreditAccountsName
    );
    const gatewayCreditTxns = dynamodb.Table.fromTableName(
      this,
      "GatewayCreditTxnsTable",
      gatewayCreditTxnsName
    );
    const gatewayCreditHolds = dynamodb.Table.fromTableName(
      this,
      "GatewayCreditHoldsTable",
      gatewayCreditHoldsName
    );
    const gatewaySessions = dynamodb.Table.fromTableName(
      this,
      "GatewaySessionsTable",
      gatewaySessionsName
    );

    // ---- 4b. SES sender identity (Phase D result delivery) -------------------
    // A verified SES (SESv2) DOMAIN identity for `agentkitproject.com` with Easy
    // DKIM, so the app can send completion notifications from
    // noreply@agentkitproject.com. When sesAutoDkimRecords is true (default) the
    // identity is bound to the EXISTING Route53 hosted zone via
    // Identity.publicHostedZone — CDK then auto-creates the three DKIM CNAME
    // records IN that zone, which auto-verifies the domain (no manual DNS step).
    // The zone is imported by its known id + name (no live lookup, so synth needs
    // no AWS creds). If cross-zone record creation is undesirable, set context
    // `sesAutoDkimRecords=false`: the identity is created WITHOUT records and the
    // DKIM tokens are emitted as CfnOutputs to add to DNS by hand.
    //
    // PRODUCTION-ACCESS CAVEAT: a brand-new SES account is in the SANDBOX — it can
    // only send to *verified* recipient addresses. Request SES production access
    // (a one-time console/support step, NOT expressible in CDK) before delivering
    // to arbitrary user-supplied recipients.
    const sesHostedZone = route53.PublicHostedZone.fromPublicHostedZoneAttributes(
      this,
      "AgentKitProjectZone",
      {
        hostedZoneId: "Z0768123E25IYRUTC9VT",
        zoneName: "agentkitproject.com"
      }
    );
    const senderIdentity = new ses.EmailIdentity(this, "AutoDeliverySenderIdentity", {
      identity: sesAutoDkimRecords
        ? // Bind to the existing zone → CDK creates the DKIM CNAMEs there
          // (Easy DKIM) and the domain auto-verifies.
          ses.Identity.publicHostedZone(sesHostedZone)
        : // Identity WITHOUT auto-records — emit DKIM tokens as outputs to add by hand.
          ses.Identity.domain(sesDomain),
      dkimSigning: true
    });
    // When NOT auto-creating records, surface the DKIM CNAME tokens so they can be
    // added to DNS manually (record name `<token>._domainkey.<domain>` → CNAME
    // `<token>.dkim.amazonses.com`). Easy-DKIM tokens are exposed via the L1.
    if (!sesAutoDkimRecords) {
      const cfn = senderIdentity.node.defaultChild as ses.CfnEmailIdentity;
      new cdk.CfnOutput(this, "SesDkimToken1", {
        value: cfn.attrDkimDnsTokenName1,
        description: "SES_DKIM_CNAME_NAME_1 (→ value SES_DKIM_CNAME_VALUE_1)"
      });
      new cdk.CfnOutput(this, "SesDkimValue1", { value: cfn.attrDkimDnsTokenValue1, description: "SES_DKIM_CNAME_VALUE_1" });
      new cdk.CfnOutput(this, "SesDkimToken2", { value: cfn.attrDkimDnsTokenName2, description: "SES_DKIM_CNAME_NAME_2" });
      new cdk.CfnOutput(this, "SesDkimValue2", { value: cfn.attrDkimDnsTokenValue2, description: "SES_DKIM_CNAME_VALUE_2" });
      new cdk.CfnOutput(this, "SesDkimToken3", { value: cfn.attrDkimDnsTokenName3, description: "SES_DKIM_CNAME_NAME_3" });
      new cdk.CfnOutput(this, "SesDkimValue3", { value: cfn.attrDkimDnsTokenValue3, description: "SES_DKIM_CNAME_VALUE_3" });
    }

    // Task role: least privilege for what the worker itself touches at runtime.
    const taskRole = new iam.Role(this, "AutoTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com")
    });
    // Run state + approvals (grants auto-include index ARNs).
    autoRunsTable.grantReadWriteData(taskRole);
    autoApprovalsTable.grantReadWriteData(taskRole);
    // Schedules (Phase B): the worker itself doesn't sweep, but the sweep runs in
    // the web app under the SSR user; the task role gets RW for parity + any future
    // worker-side schedule reads. Index ARNs are auto-included.
    autoSchedulesTable.grantReadWriteData(taskRole);
    // Webhooks (Phase C): the worker doesn't fire webhooks (the SSR web app does,
    // via the public ingest route), but grant RW for parity + any future
    // worker-side reads. Index ARNs are auto-included.
    autoWebhooksTable.grantReadWriteData(taskRole);
    // Gateway credit ledger — the worker debits during a run.
    gatewayCreditAccounts.grantReadWriteData(taskRole);
    gatewayCreditTxns.grantReadWriteData(taskRole);
    gatewayCreditHolds.grantReadWriteData(taskRole);
    // Gateway sessions — the worker's managed turn uses the session store.
    gatewaySessions.grantReadWriteData(taskRole);
    // Kit-trees bucket: Phase A run workspaces are local-ephemeral (auto-core
    // uses os.tmpdir), so this S3 RW is for kit-tree reads + future S3-backed
    // workspaces. Whole-bucket grant matches the existing simple-grant style.
    kitTrees.grantReadWrite(taskRole);
    // Phase D: the worker delivers a run's result by email via SES (SendEmail /
    // SendRawEmail). Grant the task role send permission scoped to the verified
    // sender identity's ARN. ses.identity.grantSendEmail adds ses:SendEmail; we
    // add SendRawEmail explicitly so MIME/raw sends (attachments) also work, with
    // a FromAddress condition pinning sends to the configured sender domain.
    senderIdentity.grantSendEmail(taskRole);
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail", "ses:SendRawEmail"],
        resources: [senderIdentity.emailIdentityArn],
        conditions: {
          "ForAllValues:StringLike": { "ses:FromAddress": [`*@${sesDomain}`] }
        }
      })
    );
    // Log writes: primarily the execution role (awslogs driver), task role too
    // for any direct in-container log API usage (belt-and-suspenders).
    logGroup.grantWrite(executionRole);
    logGroup.grantWrite(taskRole);
    // NOTE: deliberately NO grant on UserSettingsTable — the web app's resolve
    // endpoint reads settings, not the worker. Keep least-privilege.

    const taskDef = new ecs.FargateTaskDefinition(this, "AutoTaskDef", {
      cpu: 512,
      memoryLimitMiB: 1024,
      taskRole,
      executionRole,
      family: "agentkit-auto-worker"
    });

    // Phase D (hardened isolation): a writable, run-ephemeral scratch volume.
    // With readonlyRootFilesystem=true below, the container's "/" is read-only,
    // so the worker's per-run workspaces (auto-core FsWorkspaceStore) need a
    // dedicated writable mount. An empty volume config = a Fargate
    // ephemeral-storage-backed volume (no EFS, no host path); it lives and dies
    // with the task, which matches the run-ephemeral workspace model exactly.
    taskDef.addVolume({ name: "scratch" });

    // Non-secret config as plain environment.
    const containerEnv: { [key: string]: string } = {
      AUTO_RUNS_TABLE: autoRunsTable.tableName,
      AUTO_APPROVALS_TABLE: autoApprovalsTable.tableName,
      AUTO_SCHEDULES_TABLE: autoSchedulesTable.tableName,
      AUTO_WEBHOOKS_TABLE: autoWebhooksTable.tableName,
      // Phase C: staged run-input bucket + prefix (worker GETs during hydration).
      AUTO_INPUTS_BUCKET: kitTrees.bucketName,
      AUTO_INPUTS_PREFIX: autoInputsPrefix,
      GATEWAY_CREDIT_ACCOUNTS_TABLE: gatewayCreditAccounts.tableName,
      GATEWAY_CREDIT_TXNS_TABLE: gatewayCreditTxns.tableName,
      GATEWAY_CREDIT_HOLDS_TABLE: gatewayCreditHolds.tableName,
      GATEWAY_SESSIONS_TABLE: gatewaySessions.tableName,
      AUTO_MARKUP_BPS: autoMarkupBps,
      AUTO_CLOUD_RUN_CENTS_PER_MIN: autoCloudRunCentsPerMin,
      WEB_FORGE_INTERNAL_URL: webForgeInternalUrl,
      FORGE_AWS_REGION: this.region,
      // Phase D: the from-address the worker's EmailSender uses for result
      // delivery. Must be (a subdomain of) the verified SES identity above.
      SES_SENDER: sesSender,
      // Phase D (hardened isolation): the worker writes per-run workspaces here.
      // With readonlyRootFilesystem the only writable path is the "scratch"
      // ephemeral volume mounted at /scratch; point auto-core's workspace root
      // at a subdir of it. auto-core falls back to os.tmpdir() when unset
      // (self-host / dev), so this is purely the hosted-Fargate override.
      AUTO_WORKSPACE_DIR: "/scratch/agentkitauto-workspaces"
    };
    // Phase A: ANTHROPIC_API_KEY (platform key) and AUTO_WORKER_SERVICE_KEY are
    // passed as plain env from CDK context for simplicity; migrate to Secrets
    // Manager / SSM SecureString (ecs.Secret.fromSsmParameter) in Phase B.
    // Values come from context only (never hardcoded); omitted if absent so
    // credless/contextless synth still works.
    if (anthropicApiKey) {
      containerEnv.ANTHROPIC_API_KEY = anthropicApiKey;
    }
    if (autoWorkerServiceKey) {
      containerEnv.AUTO_WORKER_SERVICE_KEY = autoWorkerServiceKey;
    }

    // Phase D (hardened isolation): drop ALL Linux capabilities. The worker is a
    // pure Node process (HTTPS to Anthropic/web-forge, DynamoDB/S3 via the task
    // role, local fs writes to the scratch mount) — it needs no kernel
    // capabilities at all. Dropping ALL is the strongest, cleanest posture and
    // is honored by Fargate's platform.
    const linuxParameters = new ecs.LinuxParameters(this, "AutoWorkerLinuxParams");
    // Fargate does NOT support ADDING capabilities (only dropping) — so we can't
    // `drop ALL` then add back. Instead, DROP a curated list of the dangerous
    // default Docker caps while KEEPING the three the root entrypoint needs:
    // CHOWN (to chown the root-owned /scratch ephemeral volume so the non-root
    // `node` user can write its per-run workspaces) and SETUID/SETGID (for gosu
    // to drop root → node). This drops 11 of the 14 default caps; the final node
    // process is non-root and post-setuid holds no effective caps.
    linuxParameters.dropCapabilities(
      ecs.Capability.AUDIT_WRITE,
      ecs.Capability.DAC_OVERRIDE,
      ecs.Capability.FOWNER,
      ecs.Capability.FSETID,
      ecs.Capability.KILL,
      ecs.Capability.MKNOD,
      ecs.Capability.NET_BIND_SERVICE,
      ecs.Capability.NET_RAW,
      ecs.Capability.SETFCAP,
      ecs.Capability.SETPCAP,
      ecs.Capability.SYS_CHROOT
    );

    // Container name MUST stay exactly "auto-worker" — the dispatcher's
    // RunTask container override targets this name.
    const container = taskDef.addContainer("auto-worker", {
      image: ecs.ContainerImage.fromEcrRepository(workerRepo, "latest"),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "auto-worker",
        logGroup
      }),
      environment: containerEnv,
      // ── Hardened container security posture (Phase D) ──────────────────────
      // 1. Drop ALL Linux capabilities (linuxParameters, above).
      linuxParameters,
      // 2. Read-only root filesystem. The image + all node_modules/dist are
      //    immutable at runtime; the ONLY writable path is the /scratch mount.
      readonlyRootFilesystem: true
      // 3. Non-root FINAL process. Enforced in the image, NOT via the task-def
      //    `user` field — deliberately. Fargate mounts the scratch volume
      //    root-owned, and node (uid 1000) cannot write to a root-owned mount.
      //    So the container's PID 1 (the entrypoint) MUST start as root to
      //    `chown -R node:node /scratch`, then drops to `node` via `gosu` before
      //    exec'ing the worker. Pinning `user: "node"` here would start PID 1 as
      //    node, making the chown impossible and breaking every run. The
      //    security guarantee (non-root WORKER) is therefore enforced by the
      //    entrypoint's gosu drop (see Dockerfile / docker-entrypoint.sh): only
      //    the throwaway chown step is root; the long-lived node process is not.
      // 4. privileged is false by default (never set). Fargate has no
      //    `--security-opt no-new-privileges` knob, but dropping ALL caps +
      //    a non-root final process + a read-only root fs covers that intent: a
      //    non-root process with no capabilities and an immutable rootfs cannot
      //    escalate.
    });

    // Mount the writable scratch volume. readOnly:false — this is the one path
    // the worker may write (per-run workspaces under
    // /scratch/agentkitauto-workspaces, see AUTO_WORKSPACE_DIR).
    container.addMountPoints({
      sourceVolume: "scratch",
      containerPath: "/scratch",
      readOnly: false
    });

    // Egress (item 4): the AutoWorkerSg above already allows ONLY 443 + DNS
    // (UDP/TCP 53) outbound with allowAllOutbound:false — confirmed minimal and
    // left as-is. App-level traffic is further constrained by the auto-core
    // allowlist + SSRF guard; the SG is the network-layer floor.

    // ---- 6. Grant the out-of-band SSR IAM user -------------------------------
    // IAM users have a HARD 2048-byte INLINE policy limit. The SSR user's inline
    // policy is already near that limit (Kits/Settings/credit/S3 grants), so the
    // Auto grants are attached as a SEPARATE MANAGED policy (own 6144-byte limit)
    // rather than appended inline (which overflowed the 2048-byte cap).
    const ssrUser = iam.User.fromUserName(this, "SsrUser", ssrUserName);
    new iam.ManagedPolicy(this, "SsrAutoPolicy", {
      users: [ssrUser],
      statements: [
        // RunTask on the task def.
        new iam.PolicyStatement({
          actions: ["ecs:RunTask"],
          resources: [taskDef.taskDefinitionArn]
        }),
        // PassRole on both task roles (required to launch the task).
        new iam.PolicyStatement({
          actions: ["iam:PassRole"],
          resources: [taskRole.roleArn, executionRole.roleArn]
        }),
        // The web app reads/writes runs + approvals (incl. GSIs).
        new iam.PolicyStatement({
          actions: [
            "dynamodb:BatchGetItem",
            "dynamodb:GetItem",
            "dynamodb:Query",
            "dynamodb:Scan",
            "dynamodb:ConditionCheckItem",
            "dynamodb:BatchWriteItem",
            "dynamodb:PutItem",
            "dynamodb:UpdateItem",
            "dynamodb:DeleteItem",
            "dynamodb:DescribeTable"
          ],
          resources: [
            autoRunsTable.tableArn,
            `${autoRunsTable.tableArn}/index/*`,
            autoApprovalsTable.tableArn,
            `${autoApprovalsTable.tableArn}/index/*`,
            // Phase B: the SSR app does schedule CRUD + the per-minute sweep
            // (listDueSchedules over dueIndex), so it needs RW on the table + GSIs.
            autoSchedulesTable.tableArn,
            `${autoSchedulesTable.tableArn}/index/*`,
            // Phase C: webhook CRUD + the public ingest fire (getWebhook /
            // recordFire / setEnabled) all run in the SSR app — RW on table + GSI.
            autoWebhooksTable.tableArn,
            `${autoWebhooksTable.tableArn}/index/*`
          ]
        }),
        // Phase C: the SSR app issues presigned PUT URLs for run-input uploads
        // under the auto-inputs/ prefix. Presigning requires the user's own
        // s3:PutObject permission on the target key; GET is included so the SSR
        // app can also read back staged inputs if needed. Scoped to the prefix.
        new iam.PolicyStatement({
          actions: ["s3:PutObject", "s3:GetObject"],
          resources: [`${kitTrees.bucketArn}/${autoInputsPrefix}*`]
        })
      ]
    });

    // ---- 6b. Per-minute schedule-sweep trigger (Phase B) ---------------------
    // An EventBridge rule fires every minute and invokes a tiny Lambda that does a
    // single HTTPS POST to the web app's internal sweep endpoint with the shared
    // service key. The web app (SSR) then runs auto-core's runDueSchedules, which
    // selects + dispatches due schedules onto Fargate. The Lambda is intentionally
    // dependency-free (Node 20 global fetch), needs only outbound internet (the
    // default Lambda networking) + CloudWatch logs, and carries the URL + key in
    // its env from CDK context — the SAME context-secret pattern the task def uses
    // for anthropicApiKey / autoWorkerServiceKey (never hardcoded).
    //
    // COST: a 1-minute schedule is ~43,800 invocations/month of a sub-second, 128MB
    // function — trivially within free tier / a few cents/month.
    const sweepLogGroup = new logs.LogGroup(this, "AutoScheduleSweepLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });
    const sweepLambda = new lambda.Function(this, "AutoScheduleSweepFn", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      logGroup: sweepLogGroup,
      environment: {
        WEB_FORGE_INTERNAL_URL: webForgeInternalUrl,
        // AUTO_WORKER_SERVICE_KEY: same shared internal trust-boundary key the
        // resolve-context + sweep endpoints verify. Sourced from CDK context only
        // (never hardcoded); empty string when contextless so synth still works —
        // the endpoint then returns 401 until the real key is provisioned.
        AUTO_WORKER_SERVICE_KEY: autoWorkerServiceKey ?? ""
      },
      code: lambda.Code.fromInline(
        [
          "exports.handler = async () => {",
          "  const base = process.env.WEB_FORGE_INTERNAL_URL;",
          "  const key = process.env.AUTO_WORKER_SERVICE_KEY;",
          "  if (!base || !key) {",
          "    console.error('sweep: missing WEB_FORGE_INTERNAL_URL or service key');",
          "    return { ok: false, reason: 'unconfigured' };",
          "  }",
          "  const url = base.replace(/\\/$/, '') + '/api/internal/auto/sweep';",
          "  const res = await fetch(url, {",
          "    method: 'POST',",
          "    headers: { 'x-service-key': key, 'content-type': 'application/json' },",
          "    body: '{}'",
          "  });",
          "  const text = await res.text().catch(() => '');",
          // Never log the service key; log only status + a short body snippet.
          "  console.info('sweep status=' + res.status + ' body=' + text.slice(0, 200));",
          "  if (!res.ok) throw new Error('sweep failed: HTTP ' + res.status);",
          "  return { ok: true, status: res.status };",
          "};"
        ].join("\n")
      )
    });

    const sweepRule = new events.Rule(this, "AutoScheduleSweepRule", {
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      description: "Per-minute AgentKitAuto schedule sweep trigger (Phase B)"
    });
    sweepRule.addTarget(new targets.LambdaFunction(sweepLambda));

    // ---- 7. CfnOutputs -------------------------------------------------------
    new cdk.CfnOutput(this, "AutoRunsTableOut", {
      value: autoRunsTable.tableName,
      description: "AUTO_RUNS_TABLE"
    });
    new cdk.CfnOutput(this, "AutoApprovalsTableOut", {
      value: autoApprovalsTable.tableName,
      description: "AUTO_APPROVALS_TABLE"
    });
    new cdk.CfnOutput(this, "AutoSchedulesTableOut", {
      value: autoSchedulesTable.tableName,
      description: "AUTO_SCHEDULES_TABLE"
    });
    new cdk.CfnOutput(this, "AutoWebhooksTableOut", {
      value: autoWebhooksTable.tableName,
      description: "AUTO_WEBHOOKS_TABLE"
    });
    new cdk.CfnOutput(this, "AutoInputsBucketOut", {
      value: kitTrees.bucketName,
      description: "AUTO_INPUTS_BUCKET"
    });
    new cdk.CfnOutput(this, "AutoInputsPrefixOut", {
      value: autoInputsPrefix,
      description: "AUTO_INPUTS_PREFIX"
    });
    new cdk.CfnOutput(this, "AutoScheduleSweepRuleOut", {
      value: sweepRule.ruleName,
      description: "AUTO_SCHEDULE_SWEEP_RULE"
    });
    new cdk.CfnOutput(this, "AutoScheduleSweepFnOut", {
      value: sweepLambda.functionName,
      description: "AUTO_SCHEDULE_SWEEP_FUNCTION"
    });
    new cdk.CfnOutput(this, "AutoEcsCluster", {
      value: cluster.clusterName,
      description: "AUTO_ECS_CLUSTER"
    });
    new cdk.CfnOutput(this, "AutoEcsTaskDef", {
      value: taskDef.family,
      description: "AUTO_ECS_TASK_DEF"
    });
    new cdk.CfnOutput(this, "AutoEcsSubnetIds", {
      value: cdk.Fn.join(
        ",",
        vpc.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC }).subnetIds
      ),
      description: "AUTO_ECS_SUBNET_IDS"
    });
    new cdk.CfnOutput(this, "AutoEcsSecurityGroupId", {
      value: sg.securityGroupId,
      description: "AUTO_ECS_SECURITY_GROUP_ID"
    });
    new cdk.CfnOutput(this, "AutoWorkerRepoUri", {
      value: workerRepo.repositoryUri,
      description: "AUTO_WORKER_ECR_REPO_URI"
    });
    // Phase D: result-delivery SES sender + verified identity name.
    new cdk.CfnOutput(this, "SesSenderOut", {
      value: sesSender,
      description: "SES_SENDER"
    });
    new cdk.CfnOutput(this, "SesSenderIdentityOut", {
      value: senderIdentity.emailIdentityName,
      description: "SES_SENDER_IDENTITY (verified SES domain identity)"
    });
  }
}
