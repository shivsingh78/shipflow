// AWS access for the cloud wizard.
//
// Credentials live in process memory only. They are never written to disk,
// never put in shell arguments or environment variables, and every error that
// leaves this module has been passed through redactSecrets().
import { CloudError } from "../errors.js";

export const ACCESS_KEY_ID = /^(AKIA|ASIA)[A-Z0-9]{16}$/;
const KEY_ID_ANYWHERE = /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g;

/**
 * The AWS SDK is loaded lazily so that CLI commands that do not touch AWS
 * start without loading it.
 */
export async function loadSdk() {
  try {
    const [ec2, sts] = await Promise.all([
      import("@aws-sdk/client-ec2"),
      import("@aws-sdk/client-sts"),
    ]);
    return { ec2, sts };
  } catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND") {
      throw new CloudError("The AWS SDK packages are not installed.", {
        hint: "Reinstall the CLI: npm install -g shipflow-cli",
      });
    }
    throw error;
  }
}

/** Secret values that must never appear in output. */
export function secretsOf(auth) {
  return [auth?.secretAccessKey, auth?.sessionToken].filter(Boolean);
}

/**
 * Replace known secret values and access-key-ID patterns in text.
 */
export function redactSecrets(text, secrets = []) {
  let result = String(text ?? "");

  for (const secret of secrets) {
    if (secret && secret.length >= 8) {
      result = result.split(secret).join("[REDACTED]");
    }
  }

  return result
    .replace(KEY_ID_ANYWHERE, "[REDACTED-ACCESS-KEY-ID]")
    .replace(/(aws_secret_access_key|aws_session_token|SecretAccessKey|SessionToken)(["'\s:=]+)[^\s"',]+/gi, "$1$2[REDACTED]");
}

/**
 * auth: { mode: "default" | "profile" | "manual", profile?, accessKeyId?,
 *         secretAccessKey?, sessionToken? }
 */
export function clientConfig(region, auth) {
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
  constructor(message, { code, statusCode, operation } = {}) {
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
export function toAwsError(error, secrets = [], operation = "AWS request") {
  const name = error?.name || "Error";
  const raw = redactSecrets(error?.message || name, secrets).split("\n")[0].slice(0, 400);
  let message;

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
export function createApi(client, commands, { secrets = [] } = {}) {
  return {
    async call(name, input = {}) {
      const Command = commands[`${name}Command`];

      if (!Command) {
        throw new Error(`Unknown AWS operation ${name}`);
      }

      try {
        return await client.send(new Command(input));
      } catch (error) {
        throw toAwsError(error, secrets, name);
      }
    },
  };
}

export function createAwsClients({ sdk, region, auth }) {
  const config = clientConfig(region, auth);
  const secrets = secretsOf(auth);

  return {
    ec2: createApi(new sdk.ec2.EC2Client(config), sdk.ec2, { secrets }),
    sts: createApi(new sdk.sts.STSClient(config), sdk.sts, { secrets }),
  };
}

/**
 * Validate credentials with STS GetCallerIdentity before anything is created.
 */
export async function verifyIdentity(sts) {
  const result = await sts.call("GetCallerIdentity");

  return { account: result.Account, arn: result.Arn, userId: result.UserId };
}

export const isRootArn = (arn) => /:root$/.test(arn ?? "");
