/**
 * The model a whisper comes from.
 *
 * One interface, two implementations: `NoModel` — the default, and what every
 * test runs — and `OmLxModel`, an OpenAI-compatible endpoint.
 *
 * The call goes through `obsidian`'s `requestUrl`, not `fetch`: it is not subject
 * to the renderer's CORS rules, it needs no `cors_origins` setting on the server,
 * and a mobile webview cannot block it. It also means an unreachable endpoint
 * resolves as a failed response rather than a thrown network error, which is the
 * shape this module already handles.
 */

import { requestUrl } from "obsidian";

/** One completion request, already assembled. */
export interface WhisperRequest {
  system: string;
  user: string;
}

/**
 * Why a completion produced no text.
 *
 * The distinction is not cosmetic: an endpoint that refused this device and an
 * endpoint that never answered are the same silence to the idle speculation, and
 * completely different sentences to a writer who pressed a command.
 */
export type WhisperFailure =
  | { kind: "unreachable" }
  | { kind: "refused"; status: number; detail: string | null }
  | { kind: "empty"; finish: string | null };

/** What a completion produced: the model's text, or the reason there is none. */
export type WhisperReply =
  | { ok: true; text: string }
  | { ok: false; failure: WhisperFailure };

/** The model a whisper comes from. `id` is the name the endpoint is asked for. */
export interface WhisperModel {
  readonly id: string;
  complete(request: WhisperRequest): Promise<WhisperReply>;
}

/**
 * Nothing is generated and nothing is written: the default, and what `npm test`
 * uses.
 *
 * It answers `unreachable` rather than throwing, because every caller already
 * treats "no whisper" as ordinary; the runner never asks it anything at all,
 * since it is the id that turns the whole feature off.
 */
export const NoModel: WhisperModel = {
  id: "none",
  complete: () => Promise.resolve({ ok: false, failure: { kind: "unreachable" } })
};

/**
 * The server's own explanation of a non-2xx answer, flattened and capped.
 *
 * It is the difference between "the endpoint failed (HTTP 507)" and "the endpoint
 * failed (HTTP 507): Model … does not fit under the dynamic memory ceiling", and
 * only the second one tells a writer what to do. Capped because it is the
 * server's prose, not ours, and it ends up in a notice.
 */
const DETAIL_LIMIT = 140;

function serverMessage(json: unknown): string | null {
  if (typeof json !== "object" || json === null) return null;

  const record = json as Record<string, unknown>;
  const error = record.error;
  const raw =
    typeof error === "string"
      ? error
      : typeof error === "object" && error !== null
        ? (error as Record<string, unknown>).message
        : record.message;

  if (typeof raw !== "string") return null;

  const flat = raw.replace(/\s+/g, " ").trim();
  if (flat === "") return null;
  return flat.length > DETAIL_LIMIT ? `${flat.slice(0, DETAIL_LIMIT - 1).trimEnd()}…` : flat;
}

/** How the endpoint says the answer ended: `stop`, `length`, and so on. */
function replyFinish(json: unknown): string | null {
  if (typeof json !== "object" || json === null) return null;

  const choices = (json as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;

  const first: unknown = choices[0];
  if (typeof first !== "object" || first === null) return null;

  const finish = (first as Record<string, unknown>).finish_reason;
  return typeof finish === "string" ? finish : null;
}

/** The reply's text, read without trusting its shape. */
function replyContent(json: unknown): string | null {
  if (typeof json !== "object" || json === null) return null;

  const choices = (json as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;

  const first: unknown = choices[0];
  if (typeof first !== "object" || first === null) return null;

  const message = (first as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) return null;

  const content = (message as Record<string, unknown>).content;
  if (typeof content !== "string") return null;

  const trimmed = content.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * oMLX's OpenAI-compatible endpoint, one non-streaming completion per call.
 *
 * `reasoning_content` is never read: a reply that carries reasoning and no
 * content is empty content, which is this class's whole handling of thinking
 * models. `max_tokens: 320` is a decision, not a default — three rows of up to
 * fourteen words plus the JSON envelope need roughly 150 tokens, and the cap is
 * what stops a model from rambling into a minute-long answer.
 */
export class OmLxModel implements WhisperModel {
  constructor(
    private readonly endpoint: string,
    readonly id: string,
    private readonly apiKey: string
  ) {}

  async complete(request: WhisperRequest): Promise<WhisperReply> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey !== "") headers.Authorization = `Bearer ${this.apiKey}`;

    try {
      const response = await requestUrl({
        url: `${this.endpoint.replace(/\/+$/, "")}/chat/completions`,
        method: "POST",
        // Obsidian rejects a non-2xx response by default, which would turn a 401
        // into "did not answer". The status is the one thing that tells a writer
        // what to fix, so the response is read here and judged below; a socket
        // that never answered still rejects, and the catch below is still the
        // path for it.
        throw: false,
        headers,
        body: JSON.stringify({
          model: this.id,
          stream: false,
          temperature: 0.3,
          max_tokens: 320,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user }
          ]
        })
      });

      if (response.status < 200 || response.status > 299) {
        return {
          ok: false,
          failure: {
            kind: "refused",
            status: response.status,
            detail: serverMessage(response.json)
          }
        };
      }

      const text = replyContent(response.json);
      return text === null
        ? { ok: false, failure: { kind: "empty", finish: replyFinish(response.json) } }
        : { ok: true, text };
    } catch {
      // A refused connection, a timeout, a body that is not JSON: one failure,
      // because nothing about it tells the writer anything more.
      return { ok: false, failure: { kind: "unreachable" } };
    }
  }
}
