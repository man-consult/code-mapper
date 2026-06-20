import { OpenAICompatAnnotator } from "./providers/openai-compat.ts";
import type { Annotator } from "./types.ts";

export type ProviderName = "mistral" | "ollama" | "openai";

export interface AnnotatorOptions {
  provider?: ProviderName;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

/** Local-first defaults; qwen2.5-coder:7b (Apache-2.0) runs on a 16 GB laptop. */
const DEFAULT_MODELS: Record<ProviderName, string> = {
  mistral: "devstral-small-2512",
  ollama: "qwen2.5-coder:7b",
  openai: "gpt-4o-mini",
};

/**
 * Resolve an Annotator from explicit options, then environment, then defaults.
 * Secrets are read ONLY from the environment — never written anywhere.
 */
export function createAnnotator(opts: AnnotatorOptions = {}): Annotator {
  const provider =
    opts.provider ?? (process.env.CODEMAP_PROVIDER as ProviderName) ?? "ollama";

  const model = opts.model ?? process.env.CODEMAP_MODEL ?? DEFAULT_MODELS[provider];
  const baseUrl = opts.baseUrl ?? process.env.CODEMAP_BASE_URL;
  const apiKey = opts.apiKey ?? process.env.CODEMAP_API_KEY ?? envKey(provider);

  switch (provider) {
    case "mistral":
      requireKey(apiKey, "mistral", "MISTRAL_API_KEY");
      return new OpenAICompatAnnotator({
        baseUrl: baseUrl ?? "https://api.mistral.ai/v1",
        model,
        apiKey,
      });

    case "openai":
      requireKey(apiKey, "openai", "OPENAI_API_KEY");
      return new OpenAICompatAnnotator({
        baseUrl: baseUrl ?? "https://api.openai.com/v1",
        model,
        apiKey,
      });

    case "ollama":
      // Local, no key required.
      return new OpenAICompatAnnotator({
        baseUrl: baseUrl ?? "http://localhost:11434/v1",
        model,
      });

    default:
      throw new Error(`Unknown provider: ${String(provider)}`);
  }
}

function envKey(provider: ProviderName): string | undefined {
  if (provider === "mistral") return process.env.MISTRAL_API_KEY;
  if (provider === "openai") return process.env.OPENAI_API_KEY;
  return undefined;
}

function requireKey(
  key: string | undefined,
  provider: string,
  envName: string,
): asserts key is string {
  if (!key) {
    throw new Error(
      `Provider "${provider}" needs an API key. Set CODEMAP_API_KEY or ${envName}.`,
    );
  }
}
