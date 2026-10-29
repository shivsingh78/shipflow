/**
 * AI provider abstraction.
 *
 * The provider is replaceable: stages depend on `AiProvider`, never on a
 * vendor. Output is always structured through a single forced tool call, and
 * its JSON is UNTRUSTED: callers pass it through parseModelOutput.
 *
 * Credential rules (see also credentials.ts):
 *  - the only key ever used is the customer's own, unsealed in memory for the
 *    duration of one stage;
 *  - there is intentionally no code path that reads an operator-level key
 *    from the environment;
 *  - the key is only ever placed in the x-api-key header: never in a URL,
 *    prompt, log, error, audit event or queue payload.
 */

import { z } from "zod";

import { openCredential, CredentialError } from "./credentials.js";
import type { Provider } from "./credentials.js";
import { StageError } from "./errors.js";
import { redactSensitive } from "./redact.js";
import type { RepoPilotStore, RunRow } from "./store.js";

export type ProviderErrorCode =
  | "auth"
  | "rate_limited"
  | "overloaded"
  | "timeout"
  | "bad_request"
  | "too_large"
  | "refused"
  | "truncated"
  | "malformed"
  | "unavailable"
  | "cancelled";

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface AiTool {
  name: string;
  description: string;
  /** JSON Schema for the tool input (the structured answer). */
  inputSchema: Record<string, unknown>;
}

export interface AiRequest {
  system: string;
  user: string;
  tool: AiTool;
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface AiResponse {
  /** The tool input exactly as the model produced it. Untrusted. */
  toolInput: unknown;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}

export interface AiProvider {
  readonly name: Provider;
  complete(request: AiRequest): Promise<AiResponse>;
}

/** Convert a Zod schema into the JSON Schema a tool needs. */
export function toolSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;

  delete json.$schema;

  return json;
}

// --------------------------------------------------------------- Anthropic

export const ANTHROPIC_API = "https://api.anthropic.com";
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";

export type AiFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; redirect: "error"; signal: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

const MAX_RESPONSE_CHARS = 2 * 1024 * 1024;

const AnthropicMessageSchema = z.object({
  model: z.string(),
  stop_reason: z.string().nullable().optional(),
  content: z.array(z.looseObject({ type: z.string(), name: z.string().optional(), input: z.unknown().optional() })),
  usage: z.object({ input_tokens: z.number().int().min(0), output_tokens: z.number().int().min(0) }),
});

/** Map an Anthropic HTTP failure to a ProviderError. The body is never echoed in full. */
export function anthropicFailure(status: number, headers: { get(name: string): string | null }, body: string): ProviderError {
  const retryAfter = headers.get("retry-after");

  if (status === 401 || status === 403) {
    return new ProviderError("auth", "Your Anthropic API key was rejected. Check that it is valid and has access, then store it again.", false);
  }

  if (status === 429) {
    return new ProviderError("rate_limited", `Anthropic rate limit reached${retryAfter ? ` (retry after ${retryAfter}s)` : ""}.`, true);
  }

  if (status === 413) {
    return new ProviderError("too_large", "The request was too large for the provider.", false);
  }

  if (status === 529 || status === 503) {
    return new ProviderError("overloaded", "Anthropic is overloaded; try again shortly.", true);
  }

  if (status >= 500) {
    return new ProviderError("unavailable", `Anthropic is unavailable (HTTP ${status}).`, true);
  }

  if (status === 400 || status === 404 || status === 422) {
    // Error text can occasionally quote request content: keep it short and scrubbed.
    return new ProviderError("bad_request", `Anthropic rejected the request (HTTP ${status}): ${redactSensitive(body).slice(0, 160)}`, false);
  }

  return new ProviderError("unavailable", `Unexpected Anthropic response (HTTP ${status}).`, true);
}

export function createAnthropicProvider(options: { apiKey: string; model?: string; fetch?: AiFetch; timeoutMs?: number }): AiProvider {
  const doFetch: AiFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
  const timeoutMs = options.timeoutMs ?? 120_000;

  return {
    name: "anthropic",

    async complete(request) {
      const timeout = AbortSignal.timeout(timeoutMs);
      let response: Awaited<ReturnType<AiFetch>>;

      try {
        response = await doFetch(`${ANTHROPIC_API}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": options.apiKey, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model,
            max_tokens: request.maxOutputTokens,
            temperature: 0,
            system: request.system,
            messages: [{ role: "user", content: request.user }],
            tools: [{ name: request.tool.name, description: request.tool.description, input_schema: request.tool.inputSchema }],
            tool_choice: { type: "tool", name: request.tool.name },
          }),
          redirect: "error",
          signal: AbortSignal.any([request.signal, timeout]),
        });
      } catch {
        if (request.signal.aborted) {
          throw new ProviderError("cancelled", "The run was cancelled.", false);
        }

        // Never include the underlying error: it can carry the request URL or headers.
        throw timeout.aborted
          ? new ProviderError("timeout", "The AI provider did not answer in time.", true)
          : new ProviderError("unavailable", "Could not reach the AI provider.", true);
      }

      const text = (await response.text()).slice(0, MAX_RESPONSE_CHARS);

      if (response.status < 200 || response.status >= 300) {
        throw anthropicFailure(response.status, response.headers, text);
      }

      let parsed: z.infer<typeof AnthropicMessageSchema>;

      try {
        parsed = AnthropicMessageSchema.parse(JSON.parse(text));
      } catch {
        throw new ProviderError("malformed", "The AI provider returned a response in an unexpected format.", true);
      }

      if (parsed.stop_reason === "refusal") {
        throw new ProviderError("refused", "The AI provider declined to answer this request.", false);
      }

      if (parsed.stop_reason === "max_tokens") {
        throw new ProviderError("truncated", "The AI response was cut off before it finished.", true);
      }

      const block = parsed.content.find((item) => item.type === "tool_use" && item.name === request.tool.name);

      if (!block) {
        throw new ProviderError("malformed", "The AI response did not contain the requested structured answer.", true);
      }

      return { toolInput: block.input, usage: { inputTokens: parsed.usage.input_tokens, outputTokens: parsed.usage.output_tokens }, model: parsed.model };
    },
  };
}

/** Translate a provider failure into the stage-level failure the orchestrator acts on. */
export function providerFailureToStageError(error: ProviderError): StageError {
  return new StageError(`ai_${error.code}`, error.message, error.retryable);
}

// ------------------------------------------------- customer credential access

export interface ProviderFactoryDeps {
  store: RepoPilotStore;
  /** The worker's private key; null when this worker cannot decrypt credentials. */
  credentialPrivateKey: string | null;
  model?: string;
  timeoutMs?: number;
  fetch?: AiFetch;
}

/**
 * Build a provider for a run from the OWNER'S stored key. Failing closed is
 * the point: with no key, or no way to read it, the stage fails with a
 * message saying what to configure. It never substitutes another key.
 */
export async function createProviderForRun(deps: ProviderFactoryDeps, run: RunRow): Promise<AiProvider> {
  const sealed = await deps.store.readCredentialCiphertext(run.owner, "anthropic");

  if (sealed === null) {
    throw new StageError("ai_credentials_missing", "No AI provider key is stored for this account. Add your own Anthropic key; ShipFlow never uses an operator's key for your runs.", false);
  }

  if (!deps.credentialPrivateKey) {
    throw new StageError("credential_decryption_unavailable", "This worker has no REPOPILOT_CREDENTIAL_PRIVATE_KEY, so it cannot read stored provider keys.", false);
  }

  try {
    return createAnthropicProvider({
      apiKey: openCredential(deps.credentialPrivateKey, sealed),
      ...(deps.model ? { model: deps.model } : {}),
      ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
  } catch (error) {
    if (error instanceof CredentialError) {
      throw new StageError("credential_unreadable", "The stored provider key could not be decrypted with this worker's key. Store it again.", false);
    }

    throw error;
  }
}
