import Anthropic from "@anthropic-ai/sdk";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { config } from "./config.js";

/**
 * Pluggable LLM gateway. The same build talks to:
 *  - anthropic          : Claude via the Anthropic API (cloud default)
 *  - vertex             : Claude on Google Vertex AI (GCP, data stays in your project)
 *  - openai_compatible  : vLLM / Ollama / Azure OpenAI / LiteLLM (self-hosted, air-gapped)
 */
export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export async function complete(system: string, messages: LlmMessage[], maxTokens = 4096): Promise<string> {
  switch (config.LLM_PROVIDER) {
    case "anthropic": {
      const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
      const res = await client.messages.create({ model: config.LLM_MODEL, max_tokens: maxTokens, system, messages });
      return textOf(res.content);
    }
    case "vertex": {
      const client = new AnthropicVertex({ projectId: config.VERTEX_PROJECT_ID, region: config.VERTEX_REGION });
      const res = await client.messages.create({ model: config.LLM_MODEL, max_tokens: maxTokens, system, messages });
      return textOf(res.content);
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

function textOf(blocks: { type: string }[]): string {
  return blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}
