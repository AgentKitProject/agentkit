// Shared AWS client environment resolution.
//
// On Amplify SSR the managed compute role can't be granted DynamoDB/S3 access,
// and the AWS_* env names are reserved by Amplify — so a scoped IAM user's keys
// are injected via FORGE_AWS_*. Region falls back to the runtime-provided
// AWS_REGION. When no explicit keys are set, the default credential chain is
// used (local dev / instance role).
//
// Both the KitStore aws adapters (server/store/index.ts) and the gateway credit
// ledger (server/core/gateway.ts) compose against the SAME region + credentials
// via this helper so they always talk to the same account.
export type AwsClientEnv = {
  region: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
};

export function awsClientEnv(): AwsClientEnv {
  const region = process.env.FORGE_AWS_REGION || process.env.AWS_REGION || "us-east-1";
  const accessKeyId = process.env.FORGE_AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.FORGE_AWS_SECRET_ACCESS_KEY;
  return {
    region,
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {})
  };
}
