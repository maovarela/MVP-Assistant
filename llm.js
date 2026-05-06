// llm.js
// LLM client with provider fallback chain — matches Runaldo's pattern.
//
// Reads provider config from env:
//   Primary    : LLM_API_KEY            / LLM_MODEL            / LLM_BASE_URL
//   Fallback 1 : LLM_FALLBACK_1_KEY     / LLM_FALLBACK_1_MODEL / LLM_FALLBACK_1_BASE_URL
//   Fallback 2 : LLM_FALLBACK_2_KEY     / LLM_FALLBACK_2_MODEL / LLM_FALLBACK_2_BASE_URL
//
// All providers must speak the OpenAI Chat Completions API (Gemini, Groq,
// DeepSeek, OpenAI, Together, etc. all work).

import OpenAI from "openai";

function buildProviders() {
  const providers = [];

  if (process.env.LLM_API_KEY) {
    providers.push({
      name:     "primary",
      apiKey:   process.env.LLM_API_KEY,
      baseURL:  process.env.LLM_BASE_URL || undefined,
      model:    process.env.LLM_MODEL || "gemini-2.0-flash",
    });
  }

  for (const i of [1, 2]) {
    const key = process.env[`LLM_FALLBACK_${i}_KEY`];
    if (!key) continue;
    providers.push({
      name:     `fallback_${i}`,
      apiKey:   key,
      baseURL:  process.env[`LLM_FALLBACK_${i}_BASE_URL`] || undefined,
      model:    process.env[`LLM_FALLBACK_${i}_MODEL`] || "gpt-4o-mini",
    });
  }

  if (!providers.length) {
    throw new Error("No LLM provider configured. Set LLM_API_KEY at minimum.");
  }
  return providers;
}

let _providers = null;
export function getProviders() {
  if (!_providers) _providers = buildProviders();
  return _providers;
}

/**
 * Call the LLM chain. Returns the raw OpenAI ChatCompletion response from
 * the first provider that succeeds. Throws if all fail.
 *
 * opts: { messages, tools?, tool_choice?, max_tokens?, temperature?, model? }
 */
export async function callLLM(opts) {
  const { messages, tools, tool_choice, max_tokens = 2048, temperature = 0.7 } = opts;
  let lastError = null;

  for (const p of getProviders()) {
    try {
      const client = new OpenAI({ apiKey: p.apiKey, baseURL: p.baseURL });
      const params = {
        model: opts.model || p.model,
        messages,
        max_tokens,
        temperature,
      };
      if (tools)       params.tools = tools;
      if (tool_choice) params.tool_choice = tool_choice;

      console.log(`[llm] calling ${p.name} (${params.model})`);
      const response = await client.chat.completions.create(params);
      console.log(`[llm] ${p.name} ok — ${response.usage?.total_tokens ?? "?"} tokens`);
      return response;
    } catch (err) {
      console.warn(`[llm] ${p.name} failed: ${err.message}`);
      lastError = err;
    }
  }

  throw new Error(`All ${getProviders().length} LLM providers failed. Last: ${lastError?.message}`);
}

/**
 * Convenience: call LLM and return the assistant's text content directly
 * (no tool calls — for simple parsing tasks).
 */
export async function callLLMText(opts) {
  const response = await callLLM(opts);
  return response.choices[0]?.message?.content || "";
}
