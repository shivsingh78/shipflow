// AWS access for the cloud wizard.
//
// Credentials live in process memory only. They are never written to disk,
// never put in shell arguments or environment variables, and every error that
// leaves this module has been passed through redactSecrets().
import type * as Ec2Sdk from "@aws-sdk/client-ec2";
import type * as StsSdk from "@aws-sdk/client-sts";

import { CloudError, asText, errorCode } from "../errors.js";

/** The lazily loaded AWS SDK modules. */
export interface AwsSdk {
  ec2: typeof Ec2Sdk;
  sts: typeof StsSdk;
}

/**
 * auth: how to obtain credentials. "manual" credentials exist only in memory.
 */
export type AwsAuth =
  | { mode: "default" }
  | { mode: "profile"; profile?: string | undefined }
  | { mode: "manual"; accessKeyId: string; secretAccessKey: string; sessionToken?: string | undefined };

/** Operation name -> SDK input and output types. */
export type OperationMap = Record<string, { input: object; output: object }>;

/** One seam for AWS requests; tests replace it with a fake. */
export interface AwsApi<Ops extends OperationMap> {
  call<N extends keyof Ops & string>(name: N, input?: Ops[N]["input"]): Promise<Ops[N]["output"]>;
}

export interface Ec2Operations extends OperationMap {
  AuthorizeSecurityGroupIngress: {
    input: Ec2Sdk.AuthorizeSecurityGroupIngressCommandInput;
    output: Ec2Sdk.AuthorizeSecurityGroupIngressCommandOutput;
  };
  CreateSecurityGroup: {
    input: Ec2Sdk.CreateSecurityGroupCommandInput;
    output: Ec2Sdk.CreateSecurityGroupCommandOutput;
  };
  DeleteKeyPair: { input: Ec2Sdk.DeleteKeyPairCommandInput; output: Ec2Sdk.DeleteKeyPairCommandOutput };
  DeleteSecurityGroup: {
    input: Ec2Sdk.DeleteSecurityGroupCommandInput;
    output: Ec2Sdk.DeleteSecurityGroupCommandOutput;
  };
  DescribeImages: { input: Ec2Sdk.DescribeImagesCommandInput; output: Ec2Sdk.DescribeImagesCommandOutput };
  DescribeInstanceStatus: {
    input: Ec2Sdk.DescribeInstanceStatusCommandInput;
    output: Ec2Sdk.DescribeInstanceStatusCommandOutput;
  };
  DescribeInstanceTypeOfferings: {
    input: Ec2Sdk.DescribeInstanceTypeOfferingsCommandInput;
    output: Ec2Sdk.DescribeInstanceTypeOfferingsCommandOutput;
  };
  DescribeInstanceTypes: {
    input: Ec2Sdk.DescribeInstanceTypesCommandInput;
    output: Ec2Sdk.DescribeInstanceTypesCommandOutput;
  };
  DescribeInstances: {
    input: Ec2Sdk.DescribeInstancesCommandInput;
    output: Ec2Sdk.DescribeInstancesCommandOutput;
  };
  DescribeKeyPairs: {
    input: Ec2Sdk.DescribeKeyPairsCommandInput;
    output: Ec2Sdk.DescribeKeyPairsCommandOutput;
  };
  DescribeRegions: { input: Ec2Sdk.DescribeRegionsCommandInput; output: Ec2Sdk.DescribeRegionsCommandOutput };
  DescribeSecurityGroups: {
    input: Ec2Sdk.DescribeSecurityGroupsCommandInput;
    output: Ec2Sdk.DescribeSecurityGroupsCommandOutput;
  };
  DescribeSubnets: { input: Ec2Sdk.DescribeSubnetsCommandInput; output: Ec2Sdk.DescribeSubnetsCommandOutput };
  DescribeVpcs: { input: Ec2Sdk.DescribeVpcsCommandInput; output: Ec2Sdk.DescribeVpcsCommandOutput };
  GetConsoleOutput: {
    input: Ec2Sdk.GetConsoleOutputCommandInput;
    output: Ec2Sdk.GetConsoleOutputCommandOutput;
  };
  ImportKeyPair: { input: Ec2Sdk.ImportKeyPairCommandInput; output: Ec2Sdk.ImportKeyPairCommandOutput };
  RunInstances: { input: Ec2Sdk.RunInstancesCommandInput; output: Ec2Sdk.RunInstancesCommandOutput };
  TerminateInstances: {
    input: Ec2Sdk.TerminateInstancesCommandInput;
    output: Ec2Sdk.TerminateInstancesCommandOutput;
  };
}

export interface StsOperations extends OperationMap {
  GetCallerIdentity: {
    input: StsSdk.GetCallerIdentityCommandInput;
    output: StsSdk.GetCallerIdentityCommandOutput;
  };
}

/** The AWS identity the credentials resolve to. */
export interface Identity {
  account: string | undefined;
  arn: string | undefined;
  userId: string | undefined;
}

export type Ec2Api = AwsApi<Ec2Operations>;
export type StsApi = AwsApi<StsOperations>;

export interface AwsClients {
  ec2: Ec2Api;
  sts: StsApi;
}

/** What the SDK, Node and network layers attach to the errors they throw. */
interface ErrorLike {
  name?: string;
  message?: string;
  code?: string;
  $metadata?: { httpStatusCode?: number };
}

export const ACCESS_KEY_ID = /^(AKIA|ASIA)[A-Z0-9]{16}$/;
const KEY_ID_ANYWHERE = /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g;

/**
 * The AWS SDK is loaded lazily so that CLI commands that do not touch AWS
 * start without loading it.
 */
export async function loadSdk(): Promise<AwsSdk> {
  try {
    const [ec2, sts] = await Promise.all([
      import("@aws-sdk/client-ec2"),
      import("@aws-sdk/client-sts"),
    ]);
    return { ec2, sts };
  } catch (error) {
    if (errorCode(error) === "ERR_MODULE_NOT_FOUND") {
      throw new CloudError("The AWS SDK packages are not installed.", {
        hint: "Reinstall the CLI: npm install -g shipflow-cli",
      });
    }
    throw error;
  }
}

/** Secret values that must never appear in output. */
export function secretsOf(auth?: AwsAuth): string[] {
  const manual = auth?.mode === "manual" ? auth : undefined;
  return [manual?.secretAccessKey, manual?.sessionToken].filter((value): value is string => Boolean(value));
}

/**
 * Replace known secret values and access-key-ID patterns in text.
 */
export function redactSecrets(text: unknown, secrets: readonly (string | undefined)[] = []): string {
  let result = asText(text);

  for (const secret of secrets) {
    if (secret && secret.length >= 8) {
      result = result.split(secret).join("[REDACTED]");
    }
  }

  return result
    .replace(KEY_ID_ANYWHERE, "[REDACTED-ACCESS-KEY-ID]")
    .replace(/(aws_secret_access_key|aws_session_token|SecretAccessKey|SessionToken)(["'\s:=]+)[^\s"',]+/gi, "$1$2[REDACTED]");
}

export interface ClientConfig {
  region: string;
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  profile?: string;
}

export function clientConfig(region: string, auth: AwsAuth): ClientConfig {
  if (auth.mode === "manual") {
    return {
      region,
      credentials: {
        accessKeyId: auth.accessKeyId,
        secretAccessKey: auth.secretAccessKey,
        ...(auth.sessionToken ? { sessionToken: auth.sessionToken } : {}),
      },
    };
  }

  if (auth.mode === "profile" && auth.profile) {
    return { region, profile: auth.profile };
  }

  // The SDK's default chain: environment, shared config, SSO, instance role.
  return { region };
}

export class AwsError extends Error {
  code: string | undefined;
  statusCode: number | undefined;
  operation: string | undefined;

  constructor(
    message: string,
    {
      code,
      statusCode,
      operation,
    }: { code?: string | undefined; statusCode?: number | undefined; operation?: string | undefined } = {}
  ) {
    super(message);
    this.name = "AwsError";
    this.code = code;
    this.statusCode = statusCode;
    this.operation = operation;
  }
}

const CREDENTIAL_ERRORS = new Set([
  "CredentialsProviderError",
  "TokenProviderError",
  "CredentialsError",
]);

const AUTH_ERRORS = new Set([
  "InvalidClientTokenId",
  "SignatureDoesNotMatch",
  "AuthFailure",
  "ExpiredToken",
  "ExpiredTokenException",
  "UnrecognizedClientException",
  "InvalidAccessKeyId",
]);

const PERMISSION_ERRORS = new Set([
  "UnauthorizedOperation",
  "AccessDenied",
  "AccessDeniedException",
  "OptInRequired",
  "Blocked",
]);

/**
 * Turn an SDK error into an actionable, secret-free AwsError.
 */
export function toAwsError(
  caught: unknown,
  secrets: readonly (string | undefined)[] = [],
  operation = "AWS request"
): AwsError {
  const error = caught as ErrorLike | null | undefined; // SDK errors are plain Errors with extra fields
  const name = error?.name || "Error";
  const raw = (redactSecrets(error?.message || name, secrets).split("\n")[0] ?? "").slice(0, 400);
  let message: string;

  if (CREDENTIAL_ERRORS.has(name)) {
    message =
      "No usable AWS credentials were found. Run `aws sso login --profile <name>` or `aws configure`, " +
      "set AWS_* environment variables, or choose manual entry.";
  } else if (AUTH_ERRORS.has(name)) {
    message =
      `AWS rejected the credentials (${name}). Check the key pair, that a temporary session token has not ` +
      "expired, and that the region is enabled for your account.";
  } else if (PERMISSION_ERRORS.has(name)) {
    message = `${operation} is not permitted for these credentials (${name}): ${raw}. See the IAM permissions in the CLI README.`;
  } else if (error?.code === "ENOTFOUND" || error?.code === "ECONNREFUSED" || error?.code === "ETIMEDOUT") {
    message = `Cannot reach AWS (${error.code}); check your network and region.`;
  } else {
    message = `${operation} failed (${name}): ${raw}`;
  }

  return new AwsError(message, {
    code: name,
    statusCode: error?.$metadata?.httpStatusCode,
    operation,
  });
}

/**
 * One seam for every AWS request: api.call("RunInstances", input).
 * Tests replace this object; production wraps a real SDK client.
 */
export function createApi<Ops extends OperationMap>(
  client: { send(command: unknown): Promise<unknown> },
  commands: Record<string, unknown>,
  { secrets = [] }: { secrets?: readonly (string | undefined)[] } = {}
): AwsApi<Ops> {
  return {
    async call(name, input = {}) {
      const Command = commands[`${name}Command`] as (new (input: object) => unknown) | undefined;

      if (!Command) {
        throw new Error(`Unknown AWS operation ${name}`);
      }

      try {
        // The operation map ties `name` to its output type; the SDK client is untyped here.
        return (await client.send(new Command(input))) as Ops[typeof name]["output"];
      } catch (error) {
        throw toAwsError(error, secrets, name);
      }
    },
  };
}

export function createAwsClients({
  sdk,
  region,
  auth,
}: {
  sdk: AwsSdk;
  region: string;
  auth: AwsAuth;
}): AwsClients {
  const config = clientConfig(region, auth);
  const secrets = secretsOf(auth);

  return {
    ec2: createApi<Ec2Operations>(new sdk.ec2.EC2Client(config), sdk.ec2, { secrets }),
    sts: createApi<StsOperations>(new sdk.sts.STSClient(config), sdk.sts, { secrets }),
  };
}

/**
 * Validate credentials with STS GetCallerIdentity before anything is created.
 */
export async function verifyIdentity(sts: StsApi): Promise<Identity> {
  const result = await sts.call("GetCallerIdentity");

  return { account: result.Account, arn: result.Arn, userId: result.UserId };
}

export const isRootArn = (arn: string | undefined): boolean => /:root$/.test(arn ?? "");
