import type { Annotation } from "@codemap/core";
import { AnnotationSchema, type AnnotateInput, type Annotator } from "../types.ts";
import { buildUserPrompt, SYSTEM_PROMPT } from "../prompt.ts";

export interface OpenAICompatConfig {
  /** Base URL up to and including `/v1` (e.g. https://api.mistral.ai/v1). */
  baseUrl: string;
  model: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** Send `response_format: { type: "json_object" }` (default true). */
  jsonMode?: boolean;
}

/**
 * Single client covering every OpenAI-compatible chat endpoint: Mistral API,
 * Ollama (local), OpenAI, and any compatible gateway. Uses `fetch` only — no SDK.
 * The API key lives only in the Authorization header; it is never persisted.
 */
export class OpenAICompatAnnotator implements Annotator {
  readonly model: string;

  constructor(private readonly cfg: OpenAICompatConfig) {
    this.model = cfg.model;
  }

  async annotate(input: AnnotateInput): Promise<Annotation> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...this.cfg.headers,
    };
    if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;

    const body = {
      model: this.cfg.model,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(input) },
      ],
      ...(this.cfg.jsonMode === false ? {} : { response_format: { type: "json_object" } }),
    };

    const url = `${this.cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const err = new Error(`LLM request failed (${res.status}): ${detail.slice(0, 300)}`);
      // Surface the HTTP status so the retry layer can distinguish retryable
      // (429 / 5xx) from fatal (e.g. 401 bad key, 404 unknown model).
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return parseAnnotation(data.choices?.[0]?.message?.content ?? "");
  }
}

export function parseAnnotation(content: string): Annotation {
  return AnnotationSchema.parse(extractJson(content));
}

function extractJson(content: string): unknown {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Recover JSON embedded in prose or code fences.
    const match = /\{[\s\S]*\}/.exec(trimmed);
    if (match) return JSON.parse(match[0]);
    throw new Error("Model did not return valid JSON");
  }
}
