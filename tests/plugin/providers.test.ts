import test from "node:test";
import assert from "node:assert/strict";
import { setRequestUrlHandler, type RequestUrlParam, type RequestUrlResponse } from "./stubs/obsidian";
import {
  getProviderClient,
  GeminiProviderClient,
  AnthropicProviderClient,
  DeepSeekProviderClient,
  OpenAiCompatibleProviderClient,
  OllamaProviderClient,
} from "../../src/runtime/providers";

test("getProviderClient returns appropriate client and throws on unknown", () => {
  assert.ok(getProviderClient("gemini") instanceof GeminiProviderClient);
  assert.ok(getProviderClient("anthropic") instanceof AnthropicProviderClient);
  assert.ok(getProviderClient("deepseek") instanceof DeepSeekProviderClient);
  assert.ok(getProviderClient("openai-compatible") instanceof OpenAiCompatibleProviderClient);
  assert.ok(getProviderClient("openaiCompatible") instanceof OpenAiCompatibleProviderClient);
  assert.ok(getProviderClient("ollama") instanceof OllamaProviderClient);

  assert.throws(() => getProviderClient("unknown-provider"), /Unknown direct API provider/);
});

test("GeminiProviderClient: sends x-goog-api-key header and never in URL query string (SEC-20)", async () => {
  let capturedRequest: RequestUrlParam | null = null;
  setRequestUrlHandler(async (req) => {
    capturedRequest = req;
    return {
      status: 200,
      headers: {},
      text: JSON.stringify({
        candidates: [{ content: { parts: [{ text: "Hello from Gemini" }] }, finishReason: "STOP" }],
      }),
      json: {
        candidates: [{ content: { parts: [{ text: "Hello from Gemini" }] }, finishReason: "STOP" }],
      },
      arrayBuffer: new ArrayBuffer(0),
    };
  });

  const client = new GeminiProviderClient();
  const res = await client.call(
    { prompt: "Hi" },
    { apiKey: "test-gemini-key", model: "gemini-3.8-flash" }
  );

  assert.equal(res.text, "Hello from Gemini");
  assert.ok(capturedRequest);
  const req = capturedRequest as RequestUrlParam;
  assert.equal(req.headers?.["x-goog-api-key"], "test-gemini-key");
  assert.ok(!req.url.includes("key="), "API key must not leak into URL");
  assert.ok(req.url.includes("/v1beta/models/gemini-3.8-flash:generateContent"));

  setRequestUrlHandler(null);
});

test("GeminiProviderClient: structured output sets responseMimeType and responseSchema", async () => {
  let capturedBody: any = null;
  setRequestUrlHandler(async (req) => {
    capturedBody = JSON.parse(req.body as string);
    return {
      status: 200,
      headers: {},
      text: JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"result": 42}' }] }, finishReason: "STOP" }],
      }),
      json: {
        candidates: [{ content: { parts: [{ text: '{"result": 42}' }] }, finishReason: "STOP" }],
      },
      arrayBuffer: new ArrayBuffer(0),
    };
  });

  const client = new GeminiProviderClient();
  const schema = { type: "OBJECT", properties: { result: { type: "NUMBER" } } };
  const res = await client.call(
    { prompt: "Calculate", json_schema: schema, effort: "high" },
    { apiKey: "test-key" }
  );

  assert.deepEqual(res.structured_output, { result: 42 });
  assert.equal(capturedBody.generationConfig?.responseMimeType, "application/json");
  assert.deepEqual(capturedBody.generationConfig?.responseSchema, schema);
  assert.equal(capturedBody.generationConfig?.thinkingConfig?.thinkingBudget, 8192);

  setRequestUrlHandler(null);
});

test("GeminiProviderClient: throws on safety filter block", async () => {
  setRequestUrlHandler(async () => {
    return {
      status: 200,
      headers: {},
      text: JSON.stringify({
        promptFeedback: { blockReason: "SAFETY" },
      }),
      json: {
        promptFeedback: { blockReason: "SAFETY" },
      },
      arrayBuffer: new ArrayBuffer(0),
    };
  });

  const client = new GeminiProviderClient();
  await assert.rejects(
    () => client.call({ prompt: "Dangerous prompt" }, { apiKey: "test-key" }),
    /Prompt blocked by Gemini safety filters: SAFETY/
  );

  setRequestUrlHandler(null);
});

test("AnthropicProviderClient: sets x-api-key, max_tokens: 16000 (PD-14), and stop reason", async () => {
  let capturedRequest: RequestUrlParam | null = null;
  setRequestUrlHandler(async (req) => {
    capturedRequest = req;
    return {
      status: 200,
      headers: {},
      text: JSON.stringify({
        content: [{ type: "text", text: "Partial answer" }],
        stop_reason: "max_tokens",
      }),
      json: {
        content: [{ type: "text", text: "Partial answer" }],
        stop_reason: "max_tokens",
      },
      arrayBuffer: new ArrayBuffer(0),
    };
  });

  const client = new AnthropicProviderClient();
  const res = await client.call(
    { prompt: "Tell me a story" },
    { apiKey: "sk-ant-test", model: "claude-opus-5" }
  );

  assert.ok(capturedRequest);
  const req = capturedRequest as RequestUrlParam;
  assert.equal(req.headers?.["x-api-key"], "sk-ant-test");
  assert.equal(req.headers?.["anthropic-version"], "2023-06-01");
  const body = JSON.parse(req.body as string);
  assert.equal(body.max_tokens, 16000);
  assert.equal(res.truncated, true);
  assert.ok(res.text.includes("[Response truncated: max_tokens reached]"));

  setRequestUrlHandler(null);
});

test("AnthropicProviderClient: throws on refusal", async () => {
  setRequestUrlHandler(async () => {
    return {
      status: 200,
      headers: {},
      text: JSON.stringify({
        content: [],
        stop_reason: "refusal",
      }),
      json: {
        content: [],
        stop_reason: "refusal",
      },
      arrayBuffer: new ArrayBuffer(0),
    };
  });

  const client = new AnthropicProviderClient();
  await assert.rejects(
    () => client.call({ prompt: "bad" }, { apiKey: "sk-ant-test" }),
    /Response refused by model/
  );

  setRequestUrlHandler(null);
});

test("DeepSeekProviderClient: parses reasoning_content and isolates key and endpoint", async () => {
  let capturedRequest: RequestUrlParam | null = null;
  setRequestUrlHandler(async (req) => {
    capturedRequest = req;
    return {
      status: 200,
      headers: {},
      text: JSON.stringify({
        choices: [
          {
            message: {
              content: "Final deep answer",
              reasoning_content: "Step 1: thinking...",
            },
            finish_reason: "stop",
          },
        ],
      }),
      json: {
        choices: [
          {
            message: {
              content: "Final deep answer",
              reasoning_content: "Step 1: thinking...",
            },
            finish_reason: "stop",
          },
        ],
      },
      arrayBuffer: new ArrayBuffer(0),
    };
  });

  const client = new DeepSeekProviderClient();
  assert.equal(client.capabilities.supportsEffort, false);

  const res = await client.call(
    { prompt: "Solve P=NP" },
    { apiKey: "ds-secret-key", baseUrl: "https://api.deepseek.com", model: "deepseek-reasoner" }
  );

  assert.equal(res.text, "Final deep answer");
  assert.equal(res.reasoning_content, "Step 1: thinking...");
  assert.ok(capturedRequest);
  const req = capturedRequest as RequestUrlParam;
  assert.equal(req.headers?.["Authorization"], "Bearer ds-secret-key");
  assert.equal(req.url, "https://api.deepseek.com/chat/completions");

  setRequestUrlHandler(null);
});

test("OpenAiCompatibleProviderClient: key is optional for local servers (PD-40)", async () => {
  let capturedHeaders: Record<string, string> | undefined;
  setRequestUrlHandler(async (req) => {
    capturedHeaders = req.headers;
    return {
      status: 200,
      headers: {},
      text: JSON.stringify({
        choices: [{ message: { content: "Local LLM output" } }],
      }),
      json: {
        choices: [{ message: { content: "Local LLM output" } }],
      },
      arrayBuffer: new ArrayBuffer(0),
    };
  });

  const client = new OpenAiCompatibleProviderClient();
  const res = await client.call(
    { prompt: "Local hello" },
    { baseUrl: "http://localhost:8080/v1", model: "local-model" }
  );

  assert.equal(res.text, "Local LLM output");
  assert.equal(capturedHeaders?.["Authorization"], undefined, "No auth header sent when key is empty");

  setRequestUrlHandler(null);
});

test("OllamaProviderClient: keyless, calls /api/chat, and extracts verbatim error messages", async () => {
  let capturedReq: RequestUrlParam | null = null;
  setRequestUrlHandler(async (req) => {
    capturedReq = req;
    return {
      status: 404,
      headers: {},
      text: JSON.stringify({ error: "model 'llama3.2' not found, try pulling it first" }),
      json: { error: "model 'llama3.2' not found, try pulling it first" },
      arrayBuffer: new ArrayBuffer(0),
    };
  });

  const client = new OllamaProviderClient();
  assert.equal(client.capabilities.supportsEffort, false);

  await assert.rejects(
    () => client.call({ prompt: "Hello" }, { baseUrl: "http://localhost:11434" }),
    /HTTP 404: model 'llama3\.2' not found, try pulling it first/
  );

  assert.ok(capturedReq);
  const req = capturedReq as RequestUrlParam;
  assert.equal(req.url, "http://localhost:11434/api/chat");

  setRequestUrlHandler(null);
});
