#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { AgentKitForgeWebStack } from "../lib/agentkitforge-web-stack";

const app = new cdk.App();

// Stack name overridable via context: `cdk deploy -c stackName=...`.
const stackName = (app.node.tryGetContext("stackName") as string) || "AgentKitForgeWebStack";

new AgentKitForgeWebStack(app, stackName, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION
  },
  description:
    "Hosted persistence for the agentkitforge-web AWS KitStore adapter: S3 bucket (kit trees) + DynamoDB tables (kit metadata, user settings)."
});
