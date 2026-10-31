import { afterEach, describe, expect, it } from "vitest";

import { OmLxModel } from "../src/model/whisper-model";
import { requestUrlCalls, requestUrlReply } from "../test-support/obsidian-stub";

const ENDPOINT = "http://127.0.0.1:8000/v1/";
const MODEL = "Qwen3.5-4B-MLX-4bit";

const REQUEST = { system: "name the thought", user: "{ 1.1.1 }\nnote:\nprose" };

function model(apiKey = ""): OmLxModel {
  return new OmLxModel(ENDPOINT, MODEL, apiKey);
}

/** An OpenAI-compatible answer, as the endpoint would send it. */
function completion(content: unknown): unknown {
  return { choices: [{ message: { role: "assistant", content } }] };
}

afterEach(() => {
  requestUrlReply.status = 599;
  requestUrlReply.json = null;
  requestUrlReply.text = "";
  requestUrlCalls.length = 0;
});

describe("the oMLX port", () => {
  it("posts one non-streaming completion, and reads its text", async () => {
    requestUrlReply.status = 200;
    requestUrlReply.json = completion("  ~ a reading  ".trim());

    await expect(model().complete(REQUEST)).resolves.toEqual({ ok: true, text: "~ a reading" });

    const sent = requestUrlCalls[0] as Record<string, unknown>;
    expect(sent.url).toBe("http://127.0.0.1:8000/v1/chat/completions");
    expect(sent.method).toBe("POST");
    // The status is read here rather than thrown away by Obsidian's default.
    expect(sent.throw).toBe(false);
    expect(sent.headers).toEqual({ "Content-Type": "application/json" });

    const body = JSON.parse(String(sent.body)) as Record<string, unknown>;
    expect(body.model).toBe(MODEL);
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBe(320);
    expect(body.messages).toEqual([
      { role: "system", content: REQUEST.system },
      { role: "user", content: REQUEST.user }
    ]);
  });

  it("reports a refused status with its number and the server's own reason", async () => {
    requestUrlReply.status = 401;
    requestUrlReply.json = { error: { message: "API key required", type: "authentication_error" } };

    await expect(model().complete(REQUEST)).resolves.toEqual({
      ok: false,
      failure: { kind: "refused", status: 401, detail: "API key required" }
    });
  });

  it("caps a server's prose, because it ends up in a notice", async () => {
    requestUrlReply.status = 507;
    requestUrlReply.json = {
      error: {
        message: `Model (2.97GB) does not fit under the dynamic memory ceiling (815.98MB). ${"x".repeat(400)}`
      }
    };

    const reply = await model().complete(REQUEST);
    if (reply.ok) throw new Error("expected a failure");

    expect(reply.failure.kind).toBe("refused");
    if (reply.failure.kind !== "refused") return;
    expect(reply.failure.status).toBe(507);
    expect(reply.failure.detail?.length).toBeLessThanOrEqual(140);
    expect(reply.failure.detail?.endsWith("…")).toBe(true);
  });

  it("sends the key when there is one, and omits it when there is not", async () => {
    await model("secret").complete(REQUEST);
    await model().complete(REQUEST);

    expect((requestUrlCalls[0]?.headers as Record<string, string>).Authorization).toBe(
      "Bearer secret"
    );
    expect(requestUrlCalls[1]?.headers as Record<string, string>).not.toHaveProperty(
      "Authorization"
    );
  });

  it("is empty, not broken, when the answer carries reasoning and no content", async () => {
    requestUrlReply.status = 200;
    requestUrlReply.json = {
      choices: [{ finish_reason: "length", message: { content: "", reasoning_content: "hmm" } }]
    };

    // The finish reason travels, because it is the difference between "the
    // model said nothing" and "the model thought past its whole budget".
    await expect(model().complete(REQUEST)).resolves.toEqual({
      ok: false,
      failure: { kind: "empty", finish: "length" }
    });

    requestUrlReply.json = { choices: [] };
    await expect(model().complete(REQUEST)).resolves.toEqual({
      ok: false,
      failure: { kind: "empty", finish: null }
    });
  });
});
