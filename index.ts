/**
 * WOPR Plugin: OpenAI Codex Provider
 * 
 * Provides OpenAI Codex API access via the Codex SDK.
 * Note: Vision support via image URLs in prompt (SDK vision is beta/buggy).
 * Install: wopr plugin install wopr-plugin-provider-openai
 */

import type { ModelProvider, ModelClient, ModelQueryOptions } from "wopr/dist/types/provider.js";
import type { WOPRPlugin, WOPRPluginContext } from "wopr/dist/types.js";

let CodexSDK: any;

/**
 * Lazy load Codex SDK
 */
async function loadCodexSDK() {
  if (!CodexSDK) {
    try {
      const codex = await import("@openai/codex-sdk");
      CodexSDK = codex;
    } catch (error) {
      throw new Error(
        "Codex SDK not installed. Run: npm install @openai/codex-sdk"
      );
    }
  }
  return CodexSDK;
}

/**
 * OpenAI Codex provider implementation
 */
const codexProvider: ModelProvider = {
  id: "codex",
  name: "OpenAI Codex",
  description: "OpenAI Codex agent SDK for coding tasks (image URLs passed in prompt)",
  defaultModel: "codex",
  supportedModels: ["codex"],

  async validateCredentials(credential: string): Promise<boolean> {
    // API key format: sk-... (OpenAI format)
    if (!credential.startsWith("sk-")) {
      return false;
    }

    try {
      const codex = await loadCodexSDK();
      // Create a client to validate the credential
      const client = codex.createClient({ apiKey: credential });
      // Try a simple health check
      await client.health();
      return true;
    } catch (error) {
      return false;
    }
  },

  async createClient(
    credential: string,
    options?: Record<string, unknown>
  ): Promise<ModelClient> {
    return new CodexClient(credential, options);
  },

  getCredentialType(): "api-key" | "oauth" | "custom" {
    return "api-key";
  },
};

/**
 * Codex client implementation
 */
class CodexClient implements ModelClient {
  private client: any;

  constructor(
    private credential: string,
    private options?: Record<string, unknown>
  ) {
    // Set API key for Codex SDK to use
    process.env.OPENAI_API_KEY = credential;
  }

  private async getClient() {
    if (!this.client) {
      const codex = await loadCodexSDK();
      this.client = codex.createClient({
        apiKey: this.credential,
        ...this.options,
      });
    }
    return this.client;
  }

  async *query(opts: ModelQueryOptions): AsyncGenerator<any> {
    const client = await this.getClient();

    try {
      // Prepare prompt - include image URLs in text
      // Codex SDK vision is beta/buggy, so we include URLs in prompt instead
      let prompt = opts.prompt;
      if (opts.images && opts.images.length > 0) {
        const imageList = opts.images.map((url, i) => `[Image ${i + 1}]: ${url}`).join('\n');
        prompt = `[User has shared ${opts.images.length} image(s)]\n${imageList}\n\n${opts.prompt}`;
      }

      // Use Codex agent for code execution
      const q = await client.run({
        prompt,
        systemPrompt: opts.systemPrompt,
        directory: process.cwd(),
        ...opts.providerOptions,
      });

      // Stream results from Codex agent
      for await (const msg of q) {
        yield msg;
      }
    } catch (error) {
      throw new Error(
        `Codex query failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async listModels(): Promise<string[]> {
    return codexProvider.supportedModels;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const client = await this.getClient();
      await client.health();
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Plugin export
 */
const plugin: WOPRPlugin = {
  name: "provider-openai",
  version: "1.0.0",
  description: "OpenAI Codex API provider for WOPR",

  async init(ctx: WOPRPluginContext) {
    ctx.log.info("Registering OpenAI Codex provider...");
    ctx.registerProvider(codexProvider);
    ctx.log.info("OpenAI Codex provider registered");

    // Register config schema for UI
    ctx.registerConfigSchema("provider-openai", {
      title: "OpenAI Codex",
      description: "Configure OpenAI Codex API credentials",
      fields: [
        {
          name: "apiKey",
          type: "password",
          label: "API Key",
          placeholder: "sk-...",
          required: true,
          description: "Your OpenAI API key (starts with sk-)",
        },
        {
          name: "organization",
          type: "text",
          label: "Organization ID",
          placeholder: "org-... (optional)",
          required: false,
          description: "Optional: OpenAI organization ID",
        },
      ],
    });
    ctx.log.info("Registered OpenAI Codex config schema");
  },

  async shutdown() {
    console.log("[provider-openai] Shutting down");
  },
};

export default plugin;
