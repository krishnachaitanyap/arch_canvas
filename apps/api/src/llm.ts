import Anthropic from "@anthropic-ai/sdk";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { type Content, GoogleGenAI, type Part } from "@google/genai";
import { config } from "./config.js";

/**
 * Pluggable LLM gateway. The same build talks to:
 *  - gemini             : Google Gemini, through an AI Studio API key or Vertex AI (GCP)
 *  - anthropic          : Claude via the Anthropic API
 *  - vertex             : Claude on Google Vertex AI
 *  - openai_compatible  : vLLM / Ollama / Azure OpenAI / LiteLLM (text only for now)
 *
 * Two entry points: `complete()` for one-shot text, and `startToolSession()` for the agent's
 * multi-step tool-calling loop.
 */
export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export async function complete(system: string, messages: LlmMessage[], maxTokens = 4096): Promise<string> {
  switch (config.LLM_PROVIDER) {
    case "gemini": {
      const res = await gemini().models.generateContent({
        model: config.LLM_MODEL,
        contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
        config: { systemInstruction: system, maxOutputTokens: maxTokens },
      });
      return textOfParts(res.candidates?.[0]?.content?.parts);
    }
    case "anthropic":
    case "vertex": {
      const res = await claude().messages.create({ model: config.LLM_MODEL, max_tokens: maxTokens, system, messages });
      return res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    }
    case "openai_compatible": {
      const res = await fetch(`${config.OPENAI_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.OPENAI_API_KEY}` },
        body: JSON.stringify({
          model: config.LLM_MODEL,
          max_tokens: maxTokens,
          messages: [{ role: "system", content: system }, ...messages],
        }),
      });
      if (!res.ok) throw new Error(`LLM endpoint returned ${res.status}: ${await res.text()}`);
      const json = (await res.json()) as { choices: { message: { content: string } }[] };
      return json.choices[0]?.message.content ?? "";
    }
    case "none":
      throw new Error("AI is disabled (LLM_PROVIDER=none)");
  }
}

// ------------------------------------------------------------------ tool calling

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}
export interface ToolResult {
  call: ToolCall;
  result: unknown;
}
export interface ModelTurn {
  text: string;
  calls: ToolCall[];
}
/** A conversation that keeps provider-native history; pass tool results back with each step. */
export interface ToolSession {
  step(results?: ToolResult[]): Promise<ModelTurn>;
}

export function startToolSession(system: string, history: LlmMessage[], tools: ToolSpec[]): ToolSession {
  switch (config.LLM_PROVIDER) {
    case "gemini":
      return geminiSession(system, history, tools);
    case "anthropic":
    case "vertex":
      return claudeSession(system, history, tools);
    case "openai_compatible":
      throw new Error("The diagram agent needs tool calling; use LLM_PROVIDER=gemini, anthropic or vertex");
    case "none":
      throw new Error("AI is disabled (LLM_PROVIDER=none)");
  }
}

function geminiSession(system: string, history: LlmMessage[], tools: ToolSpec[]): ToolSession {
  const ai = gemini();
  const contents: Content[] = history.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  return {
    async step(results) {
      if (results?.length)
        contents.push({
          role: "user",
          parts: results.map((r) => ({
            functionResponse: {
              ...(r.call.id.startsWith("gen-") ? {} : { id: r.call.id }),
              name: r.call.name,
              response: { output: r.result },
            },
          })),
        });
      const res = await ai.models.generateContent({
        model: config.LLM_MODEL,
        contents,
        config: {
          systemInstruction: system,
          tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }],
        },
      });
      const content = res.candidates?.[0]?.content;
      // Keep the model's turn verbatim: it carries thought signatures Gemini needs on the next step.
      if (content) contents.push({ role: "model", parts: content.parts ?? [] });
      const calls = (content?.parts ?? [])
        .filter((p) => p.functionCall)
        .map((p, i) => ({
          id: p.functionCall!.id ?? `gen-${contents.length}-${i}`,
          name: p.functionCall!.name ?? "",
          args: (p.functionCall!.args ?? {}) as Record<string, unknown>,
        }));
      if (!content && res.promptFeedback?.blockReason) throw new Error(`Gemini blocked the request: ${res.promptFeedback.blockReason}`);
      return { text: textOfParts(content?.parts), calls };
    },
  };
}

function claudeSession(system: string, history: LlmMessage[], tools: ToolSpec[]): ToolSession {
  const client = claude();
  const messages: Anthropic.MessageParam[] = history.map((m) => ({ role: m.role, content: m.content }));
  return {
    async step(results) {
      if (results?.length)
        messages.push({
          role: "user",
          content: results.map((r) => ({ type: "tool_result" as const, tool_use_id: r.call.id, content: JSON.stringify(r.result) })),
        });
      const res = await client.messages.create({
        model: config.LLM_MODEL,
        max_tokens: 8192,
        system,
        messages,
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Tool.InputSchema })),
      });
      messages.push({ role: "assistant", content: res.content });
      return {
        text: res.content.map((b) => (b.type === "text" ? b.text : "")).join(""),
        calls: res.content
          .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
          .map((b) => ({ id: b.id, name: b.name, args: b.input as Record<string, unknown> })),
      };
    },
  };
}

// ------------------------------------------------------------------ clients

let geminiClient: GoogleGenAI | undefined;
function gemini(): GoogleGenAI {
  geminiClient ??= config.GEMINI_API_KEY
    ? new GoogleGenAI({ apiKey: config.GEMINI_API_KEY })
    : new GoogleGenAI({ vertexai: true, project: config.VERTEX_PROJECT_ID, location: config.VERTEX_REGION });
  return geminiClient;
}

let claudeClient: Anthropic | AnthropicVertex | undefined;
function claude(): Anthropic | AnthropicVertex {
  claudeClient ??=
    config.LLM_PROVIDER === "vertex"
      ? new AnthropicVertex({ projectId: config.VERTEX_PROJECT_ID, region: config.VERTEX_REGION })
      : new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  return claudeClient;
}

function textOfParts(parts: Part[] | undefined): string {
  return (parts ?? [])
    .filter((p) => typeof p.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("");
}
