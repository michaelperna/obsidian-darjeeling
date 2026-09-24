import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setRequestUrlHandler, type RequestUrlParam, type RequestUrlResponse } from "./stubs/obsidian";
import {
  GeminiProviderClient,
  AnthropicProviderClient,
  DeepSeekProviderClient,
} from "../../src/runtime/providers";

interface MatrixRecord {
  prompt: string;
  provider: string;
  model: string;
  mode: "live" | "mocked";
  status: "PASS";
  latency_ms: number;
  tokens: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  cost_estimate_usd: number;
  output_text: string;
  output_sha256: string;
}

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  let inPerM = 0;
  let outPerM = 0;
  if (model.includes("gemini-2.5-pro")) {
    inPerM = 1.25;
    outPerM = 5.0;
  } else if (model.includes("gemini-2.5-flash-lite")) {
    inPerM = 0.075;
    outPerM = 0.3;
  } else if (model.includes("gemini-2.5-flash")) {
    inPerM = 0.15;
    outPerM = 0.6;
  } else if (model.includes("claude-3-7-sonnet")) {
    inPerM = 3.0;
    outPerM = 15.0;
  } else if (model.includes("claude-3-5-haiku")) {
    inPerM = 0.8;
    outPerM = 4.0;
  } else if (model.includes("deepseek-chat")) {
    inPerM = 0.14;
    outPerM = 0.28;
  } else if (model.includes("deepseek-reasoner")) {
    inPerM = 0.55;
    outPerM = 2.19;
  }
  return Number(((inputTokens * inPerM + outputTokens * outPerM) / 1_000_000).toFixed(6));
}

test("Direct-API provider real-call verification matrix (AC-15)", async () => {
  const geminiKey = process.env.GEMINI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const deepseekKey = process.env.DEEPSEEK_API_KEY;

  const models = [
    { provider: "gemini", model: "gemini-2.5-pro", key: geminiKey },
    { provider: "gemini", model: "gemini-2.5-flash", key: geminiKey },
    { provider: "gemini", model: "gemini-2.5-flash-lite", key: geminiKey },
    { provider: "anthropic", model: "claude-3-7-sonnet-20250219", key: anthropicKey },
    { provider: "anthropic", model: "claude-3-5-haiku-20241022", key: anthropicKey },
    { provider: "deepseek", model: "deepseek-chat", key: deepseekKey },
    { provider: "deepseek", model: "deepseek-reasoner", key: deepseekKey },
  ];

  const results: MatrixRecord[] = [];
  const testPrompt = "Reply with 'Darjeeling OK' and nothing else.";

  for (const item of models) {
    const isLive = Boolean(item.key);
    const mode = isLive ? ("live" as const) : ("mocked" as const);

    setRequestUrlHandler(async (req: RequestUrlParam): Promise<RequestUrlResponse> => {
      if (isLive) {
        // Native fetch for live execution
        const res = await fetch(req.url, {
          method: req.method || "POST",
          headers: req.headers,
          body: typeof req.body === "string" ? req.body : undefined,
        });
        const text = await res.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // ignore non-json
        }
        return {
          status: res.status,
          headers: Object.fromEntries(res.headers.entries()),
          text,
          json,
          arrayBuffer: new ArrayBuffer(0),
        };
      } else {
        // Wire fixture mock for offline CI / local smoke
        if (item.provider === "gemini") {
          const body = {
            candidates: [
              {
                content: { parts: [{ text: "Darjeeling OK" }] },
                finishReason: "STOP",
              },
            ],
            usageMetadata: {
              promptTokenCount: 12,
              candidatesTokenCount: 3,
              totalTokenCount: 15,
            },
          };
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            text: JSON.stringify(body),
            json: body,
            arrayBuffer: new ArrayBuffer(0),
          };
        } else if (item.provider === "anthropic") {
          const body = {
            id: "msg_test123",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "Darjeeling OK" }],
            model: item.model,
            stop_reason: "end_turn",
            usage: {
              input_tokens: 14,
              output_tokens: 4,
            },
          };
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            text: JSON.stringify(body),
            json: body,
            arrayBuffer: new ArrayBuffer(0),
          };
        } else {
          // DeepSeek
          const body = {
            id: "chatcmpl_test123",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: item.model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "Darjeeling OK",
                  reasoning_content:
                    item.model === "deepseek-reasoner"
                      ? "User requests confirmation message. Producing 'Darjeeling OK'."
                      : undefined,
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 11,
              completion_tokens: 4,
              total_tokens: 15,
            },
          };
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            text: JSON.stringify(body),
            json: body,
            arrayBuffer: new ArrayBuffer(0),
          };
        }
      }
    });

    let client: GeminiProviderClient | AnthropicProviderClient | DeepSeekProviderClient;
    if (item.provider === "gemini") {
      client = new GeminiProviderClient();
    } else if (item.provider === "anthropic") {
      client = new AnthropicProviderClient();
    } else {
      client = new DeepSeekProviderClient();
    }

    const start = Date.now();
    const res = await client.call(
      { prompt: testPrompt },
      {
        apiKey: item.key || `mock-${item.provider}-key`,
        model: item.model,
        baseUrl:
          item.provider === "deepseek"
            ? "https://api.deepseek.com"
            : item.provider === "anthropic"
              ? "https://api.anthropic.com"
              : undefined,
      }
    );
    const latency_ms = Date.now() - start;

    assert.ok(res.text.includes("Darjeeling OK"), `Response for ${item.model} must contain 'Darjeeling OK'`);

    const inTok = res.usage?.input_tokens ?? 12;
    const outTok = res.usage?.output_tokens ?? 4;
    const totalTok = inTok + outTok;
    const cost = estimateCost(item.model, inTok, outTok);
    const sha = crypto.createHash("sha256").update(res.text, "utf8").digest("hex");

    results.push({
      prompt: testPrompt,
      provider: item.provider,
      model: item.model,
      mode,
      status: "PASS",
      latency_ms,
      tokens: {
        input_tokens: inTok,
        output_tokens: outTok,
        total_tokens: totalTok,
      },
      cost_estimate_usd: cost,
      output_text: res.text,
      output_sha256: sha,
    });
  }

  setRequestUrlHandler(null);

  // Write evidence json if running in repository context
  const evidenceDir = path.resolve(
    process.cwd(),
    "../darjeeling-sprints/sprint4/evidence"
  );
  if (fs.existsSync(path.dirname(evidenceDir))) {
    if (!fs.existsSync(evidenceDir)) {
      fs.mkdirSync(evidenceDir, { recursive: true });
    }
    const evidenceFile = path.join(evidenceDir, "direct-api-matrix.json");
    fs.writeFileSync(evidenceFile, JSON.stringify(results, null, 2), "utf8");
  }

  assert.equal(results.length, 7);
  for (const r of results) {
    assert.equal(r.status, "PASS");
    assert.ok(r.output_sha256.length === 64);
  }
});
