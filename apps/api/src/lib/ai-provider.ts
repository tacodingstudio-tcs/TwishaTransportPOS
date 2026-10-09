// apps/api/src/lib/ai-provider.ts
//
// AI provider abstraction layer.
// All AI services call this instead of the Anthropic SDK directly.
// Switch providers by setting AI_PROVIDER in .env — no code changes needed.
//
// Supported providers:
//   anthropic    — Anthropic Claude API (default)
//   ollama       — Local models via Ollama (llama3, mistral, gemma, etc.)
//   custom_http  — Your own AI service (any stack, any model)
//
// Custom HTTP contract — your service must implement:
//   POST /ai/chat
//   Body:  { system: string, prompt: string, max_tokens?: number }
//   Reply: { text: string }

import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenerativeAI, type Part } from '@google/generative-ai'
import OpenAI from 'openai'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AIMessage {
  system: string
  prompt: string
  maxTokens?: number
  /** Hint to the provider: prefer fast/cheap (haiku) or powerful (sonnet) */
  quality?: 'fast' | 'best'
}

export interface AIImageMessage extends AIMessage {
  imageBase64: string
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp'
}

export interface AIProvider {
  chat(msg: AIMessage): Promise<string>
  vision(msg: AIImageMessage): Promise<string>
}

// ── Anthropic provider ────────────────────────────────────────────────────────

class AnthropicProvider implements AIProvider {
  private client = new Anthropic()

  private model(quality: AIMessage['quality']) {
    return quality === 'best' ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001'
  }

  async chat(msg: AIMessage): Promise<string> {
    const res = await this.client.messages.create({
      model:      this.model(msg.quality),
      max_tokens: msg.maxTokens ?? 1024,
      system:     msg.system,
      messages:   [{ role: 'user', content: msg.prompt }],
    })
    const block = res.content.find((b) => b.type === 'text')
    return block?.type === 'text' ? block.text : ''
  }

  async vision(msg: AIImageMessage): Promise<string> {
    const res = await this.client.messages.create({
      model:      this.model('best'),  // vision always needs the capable model
      max_tokens: msg.maxTokens ?? 2048,
      system:     msg.system,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: msg.mediaType, data: msg.imageBase64 } },
          { type: 'text', text: msg.prompt },
        ],
      }],
    })
    const block = res.content.find((b) => b.type === 'text')
    return block?.type === 'text' ? block.text : ''
  }
}

// ── Ollama provider (local) ───────────────────────────────────────────────────

class OllamaProvider implements AIProvider {
  private baseUrl: string
  private model:   string

  constructor() {
    this.baseUrl = process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434'
    this.model   = process.env['OLLAMA_MODEL']    ?? 'llama3'
  }

  private async generate(system: string, prompt: string, maxTokens = 1024): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:  this.model,
        prompt: `<|system|>\n${system}\n<|user|>\n${prompt}\n<|assistant|>`,
        stream: false,
        options: { num_predict: maxTokens },
      }),
    })

    if (!res.ok) {
      throw new Error(`Ollama error ${res.status}: ${await res.text()}`)
    }

    const data = await res.json() as { response: string }
    return data.response ?? ''
  }

  async chat(msg: AIMessage): Promise<string> {
    return this.generate(msg.system, msg.prompt, msg.maxTokens)
  }

  async vision(msg: AIImageMessage): Promise<string> {
    // Ollama vision via llava model
    const visionModel = process.env['OLLAMA_VISION_MODEL'] ?? 'llava'
    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:  visionModel,
        prompt: msg.prompt,
        images: [msg.imageBase64],
        stream: false,
        options: { num_predict: msg.maxTokens ?? 2048 },
      }),
    })

    if (!res.ok) {
      throw new Error(`Ollama vision error ${res.status}: ${await res.text()}`)
    }

    const data = await res.json() as { response: string }
    return data.response ?? ''
  }
}

// ── Gemini provider ───────────────────────────────────────────────────────────

class GeminiProvider implements AIProvider {
  private genAI: GoogleGenerativeAI

  constructor() {
    const key = process.env['GEMINI_API_KEY']
    if (!key) throw new Error('GEMINI_API_KEY is not set in environment')
    this.genAI = new GoogleGenerativeAI(key)
  }

  private model() {
    return this.genAI.getGenerativeModel({ model: 'gemini-2.0-flash' })
  }

  async chat(msg: AIMessage): Promise<string> {
    const model = this.model()
    const result = await model.generateContent([
      { text: `${msg.system}\n\n${msg.prompt}` },
    ])
    return result.response.text()
  }

  async vision(msg: AIImageMessage): Promise<string> {
    const model = this.model()
    const imagePart: Part = {
      inlineData: { mimeType: msg.mediaType, data: msg.imageBase64 },
    }
    const result = await model.generateContent([
      { text: `${msg.system}\n\n${msg.prompt}` },
      imagePart,
    ])
    return result.response.text()
  }
}

// ── Gemini notes provider — always uses Gemini regardless of AI_PROVIDER ──────
// Used specifically for chapter scanning / study notes generation.
// Falls back to the default AI provider if GEMINI_API_KEY is not set.
export function createGeminiProvider(): AIProvider {
  try {
    return new GeminiProvider()
  } catch {
    console.warn('[AI] GEMINI_API_KEY not set — falling back to default AI provider for notes')
    return ai
  }
}

// ── OpenAI provider ───────────────────────────────────────────────────────────

class OpenAIProvider implements AIProvider {
  private client = new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] })

  private model(quality: AIMessage['quality']) {
    return quality === 'best' ? 'gpt-4o' : 'gpt-4o-mini'
  }

  async chat(msg: AIMessage): Promise<string> {
    const res = await this.client.chat.completions.create({
      model:      this.model(msg.quality),
      max_tokens: msg.maxTokens ?? 1024,
      messages: [
        { role: 'system', content: msg.system },
        { role: 'user',   content: msg.prompt },
      ],
    })
    return res.choices[0]?.message?.content ?? ''
  }

  async vision(msg: AIImageMessage & { extraImages?: Array<{ base64: string; mediaType: string }> }): Promise<string> {
    const content: any[] = [
      { type: 'text', text: `${msg.system}\n\n${msg.prompt}` },
      { type: 'image_url', image_url: { url: `data:${msg.mediaType};base64,${msg.imageBase64}` } },
    ]
    // Append extra pages (multi-image support)
    if (msg.extraImages?.length) {
      for (const img of msg.extraImages) {
        content.push({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.base64}` } })
      }
    }
    const res = await this.client.chat.completions.create({
      model:      'gpt-4o',
      max_tokens: msg.maxTokens ?? 2048,
      messages:   [{ role: 'user', content }],
    })
    return res.choices[0]?.message?.content ?? ''
  }
}

// ── Custom HTTP provider (your own AI service) ────────────────────────────────
//
// Your service must implement:
//   POST /ai/chat
//   Body:  { system: string, prompt: string, max_tokens: number, quality: string }
//   Reply: { text: string }
//
//   POST /ai/vision
//   Body:  { system: string, prompt: string, image_base64: string, media_type: string }
//   Reply: { text: string }
//
// Set CUSTOM_AI_BASE_URL and optionally CUSTOM_AI_API_KEY in .env

class CustomHttpProvider implements AIProvider {
  private baseUrl: string
  private apiKey:  string | undefined

  constructor() {
    this.baseUrl = process.env['CUSTOM_AI_BASE_URL'] ?? 'http://localhost:8000'
    this.apiKey  = process.env['CUSTOM_AI_API_KEY']
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`
    return h
  }

  async chat(msg: AIMessage): Promise<string> {
    const res = await fetch(`${this.baseUrl}/ai/chat`, {
      method:  'POST',
      headers: this.headers(),
      body: JSON.stringify({
        system:     msg.system,
        prompt:     msg.prompt,
        max_tokens: msg.maxTokens ?? 1024,
        quality:    msg.quality ?? 'fast',
      }),
    })

    if (!res.ok) {
      throw new Error(`Custom AI error ${res.status}: ${await res.text()}`)
    }

    const data = await res.json() as { text: string }
    return data.text ?? ''
  }

  async vision(msg: AIImageMessage): Promise<string> {
    const res = await fetch(`${this.baseUrl}/ai/vision`, {
      method:  'POST',
      headers: this.headers(),
      body: JSON.stringify({
        system:       msg.system,
        prompt:       msg.prompt,
        image_base64: msg.imageBase64,
        media_type:   msg.mediaType,
      }),
    })

    if (!res.ok) {
      throw new Error(`Custom AI vision error ${res.status}: ${await res.text()}`)
    }

    const data = await res.json() as { text: string }
    return data.text ?? ''
  }
}

// ── Factory — reads AI_PROVIDER from env ──────────────────────────────────────

function createProvider(): AIProvider {
  const provider = process.env['AI_PROVIDER'] ?? 'anthropic'

  switch (provider) {
    case 'anthropic':   return new AnthropicProvider()
    case 'gemini':      return new GeminiProvider()
    case 'openai':      return new OpenAIProvider()
    case 'ollama':      return new OllamaProvider()
    case 'custom_http': return new CustomHttpProvider()
    default:
      console.warn(`[AI] Unknown provider "${provider}", falling back to anthropic`)
      return new AnthropicProvider()
  }
}

// Singleton — created once at startup
export const ai = createProvider()

// ── Helper: parse JSON from AI response (strips markdown fences) ──────────────
export function parseAIJson<T>(raw: string): T | null {
  if (!raw) return null
  // Strip markdown fences
  let cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
  // Try direct parse first
  try { return JSON.parse(cleaned) as T } catch { /* continue */ }
  // Extract largest {...} or [...] block
  const firstBrace = cleaned.indexOf('{')
  const firstBracket = cleaned.indexOf('[')
  const start = firstBrace === -1 ? firstBracket : firstBracket === -1 ? firstBrace : Math.min(firstBrace, firstBracket)
  if (start !== -1) {
    const lastBrace = cleaned.lastIndexOf('}')
    const lastBracket = cleaned.lastIndexOf(']')
    const end = Math.max(lastBrace, lastBracket)
    if (end > start) {
      try { return JSON.parse(cleaned.slice(start, end + 1)) as T } catch { /* continue */ }
    }
  }
  return null
}
