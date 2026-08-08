import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const buildDir = process.env.PI_KIRO_PROVIDER_BUILD_DIR;
if (!buildDir) throw new Error("PI_KIRO_PROVIDER_BUILD_DIR is required.");

const fromBuild = (path) => pathToFileURL(join(buildDir, path)).href;
const { createKiroStream } = await import(fromBuild("src/kiro.js"));
const { crc32 } = await import(fromBuild("src/eventstream.js"));

const encoder = new TextEncoder();

function createLogger(events = []) {
  return {
    debug(event, details) { events.push({ level: "debug", event, details }); },
    warn(event, details) { events.push({ level: "warn", event, details }); },
    error(event, details) { events.push({ level: "error", event, details }); },
  };
}

function createModel() {
  return {
    id: "kiro-test",
    name: "Kiro Test",
    api: "kiro",
    provider: "kiro",
    baseUrl: "https://kiro.example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_000,
  };
}

test("ACP fallback keeps an invalid CLI path inside the stream error contract", async () => {
  const originalFetch = globalThis.fetch;
  const logs = [];
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ message: "expired bearer token" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });

    const stream = createKiroStream({
      apiKey: "token",
      providerId: "kiro",
      upstreamUrl: "https://kiro.example.invalid/generate",
      requestTimeoutMs: 1_000,
      cliFallback: true,
      kiroCliPath: "/definitely/missing/kiro-cli",
    }, {}, createLogger(logs))(createModel(), {
      messages: [{ role: "user", content: "hello" }],
    });

    for await (const _event of stream) {
      // Drain the stream so the request and fallback both complete.
    }

    const result = await stream.result();
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage, /HTTP 401 \(unauthorized\)/);
    const failure = logs.find(({ event }) => event === "acp_fallback_failed");
    assert.ok(failure);
    assert.equal(failure.details.cliPath, "/definitely/missing/kiro-cli");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function encodeHeader(name, value) {
  const nameBytes = encoder.encode(name);
  const valueBytes = encoder.encode(value);
  const header = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
  let offset = 0;
  header[offset] = nameBytes.length;
  offset += 1;
  header.set(nameBytes, offset);
  offset += nameBytes.length;
  header[offset] = 7;
  offset += 1;
  header[offset] = (valueBytes.length >>> 8) & 0xff;
  header[offset + 1] = valueBytes.length & 0xff;
  offset += 2;
  header.set(valueBytes, offset);
  return header;
}

function concatBytes(chunks) {
  const totalLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function createFrame(eventType, payload) {
  const headerBytes = encodeHeader(":event-type", eventType);
  const payloadBytes = encoder.encode(JSON.stringify(payload));
  const totalLength = 12 + headerBytes.length + payloadBytes.length + 4;
  const frame = new Uint8Array(totalLength);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  view.setUint32(0, totalLength, false);
  view.setUint32(4, headerBytes.length, false);
  view.setUint32(8, crc32(frame.subarray(0, 8)), false);
  frame.set(headerBytes, 12);
  frame.set(payloadBytes, 12 + headerBytes.length);
  view.setUint32(totalLength - 4, crc32(frame.subarray(0, totalLength - 4)), false);
  return frame;
}

function createResponse(events) {
  const body = concatBytes(events.map(([eventType, payload]) => createFrame(eventType, payload)));
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(body);
      controller.close();
    },
  }), { status: 200 });
}

test("Kiro forwards every active tool, including terminal access", async () => {
  const originalFetch = globalThis.fetch;
  let requestPayload;
  try {
    globalThis.fetch = async (_url, init) => {
      requestPayload = JSON.parse(init.body);
      return createResponse([["metricsEvent", { inputTokens: 1, outputTokens: 1 }]]);
    };

    const stream = createKiroStream({
      apiKey: "token",
      providerId: "kiro",
      upstreamUrl: "https://kiro.example.invalid/generate",
      requestTimeoutMs: 1_000,
    }, {}, createLogger())(createModel(), {
      messages: [{ role: "user", content: "run the tests" }],
      tools: [
        { name: "bash", description: "Run commands in the terminal", parameters: { type: "object" } },
        { name: "read", description: "Read files", parameters: { type: "object" } },
      ],
    });

    for await (const _event of stream) {
      // Drain the response so the request completes.
    }

    const tools = requestPayload.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools;
    assert.deepEqual(tools.map((entry) => entry.toolSpecification.name), ["bash", "read"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Kiro toolUseEvent updates same-id tool calls with latest complete arguments", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => createResponse([
      ["toolUseEvent", { toolUseId: "tooluse_find", name: "find", input: {} }],
      ["toolUseEvent", { toolUseId: "tooluse_find", name: "find", input: { path: "src", pattern: "*.ts" } }],
      ["metricsEvent", { inputTokens: 1, outputTokens: 1 }],
    ]);

    const stream = createKiroStream({
      apiKey: "token",
      providerId: "kiro",
      upstreamUrl: "https://kiro.example.invalid/generate",
      requestTimeoutMs: 1_000,
    }, {}, createLogger())(createModel(), {
      messages: [{ role: "user", content: "find TypeScript files" }],
      tools: [{ name: "find", description: "Find files", parameters: { type: "object" } }],
    });

    const events = [];
    for await (const event of stream) events.push(event);
    const toolStarts = events.filter((event) => event.type === "toolcall_start");
    const toolEnds = events.filter((event) => event.type === "toolcall_end");
    const message = await stream.result();

    assert.equal(toolStarts.length, 1);
    assert.equal(toolEnds.length, 1);
    assert.equal(message.stopReason, "toolUse");
    assert.deepEqual(toolEnds[0].toolCall, {
      type: "toolCall",
      id: "tooluse_find",
      name: "find",
      arguments: { path: "src", pattern: "*.ts" },
    });
    assert.deepEqual(message.content, [toolEnds[0].toolCall]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Kiro fragmented same-id string inputs are accumulated before tool call end", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => createResponse([
      ["toolUseEvent", { toolUseId: "tooluse_grep", name: "grep", input: "{\"path\":" }],
      ["toolUseEvent", { toolUseId: "tooluse_grep", name: "grep", input: "\"src\",\"pattern\":\"toolUseEvent\"}" }],
    ]);

    const stream = createKiroStream({
      apiKey: "token",
      providerId: "kiro",
      upstreamUrl: "https://kiro.example.invalid/generate",
      requestTimeoutMs: 1_000,
    }, {}, createLogger())(createModel(), {
      messages: [{ role: "user", content: "grep tool events" }],
      tools: [{ name: "grep", description: "Search files", parameters: { type: "object" } }],
    });

    const events = [];
    for await (const event of stream) events.push(event);
    const toolStarts = events.filter((event) => event.type === "toolcall_start");
    const toolEnds = events.filter((event) => event.type === "toolcall_end");

    assert.equal(toolStarts.length, 1);
    assert.equal(toolEnds.length, 1);
    assert.deepEqual(toolEnds[0].toolCall.arguments, { path: "src", pattern: "toolUseEvent" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
