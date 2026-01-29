/**
 * WOPR Plugin: OpenAI Codex Provider
 *
 * Provides OpenAI Codex API access via the Codex SDK.
 * Supports A2A tools via MCP server configuration.
 * Note: Vision support via image URLs in prompt (SDK vision is beta/buggy).
 * Install: wopr plugin install wopr-plugin-provider-openai
 */

import winston from "winston";

// Type definitions (peer dependency from wopr)
interface A2AToolResult {
  content: Array<{
    type: "text" | "image" | "resource";
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

interface A2AToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<A2AToolResult>;
}

interface A2AServerConfig {
  name: string;
  version?: string;
  tools: A2AToolDefinition[];
}

interface ModelQueryOptions {
  prompt: string;
  systemPrompt?: string;
  resume?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  images?: string[];
  tools?: string[];
  a2aServers?: Record<string, A2AServerConfig>;
  allowedTools?: string[];
  providerOptions?: Record<string, unknown>;
}

interface ModelClient {
  query(options: ModelQueryOptions): AsyncGenerator<unknown>;
  listModels(): Promise<string[]>;
  healthCheck(): Promise<boolean>;
}

interface ModelProvider {
  id: string;
  name: string;
  description: string;
  defaultModel: string;
  supportedModels: string[];
  validateCredentials(credentials: string): Promise<boolean>;
  createClient(credential: string, options?: Record<string, unknown>): Promise<ModelClient>;
  getCredentialType(): "api-key" | "oauth" | "custom";
}

interface ConfigField {
  name: string;
  type: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  description?: string;
  options?: Array<{ value: string; label: string }>;
  default?: unknown;
}

interface ConfigSchema {
  title: string;
  description: string;
  fields: ConfigField[];
}

interface WOPRPluginContext {
  log: { info: (msg: string) => void };
  registerProvider: (provider: ModelProvider) => void;
  registerConfigSchema: (name: string, schema: ConfigSchema) => void;
}

interface WOPRPlugin {
  name: string;
  version: string;
  description: string;
  init(ctx: WOPRPluginContext): Promise<void>;
  shutdown(): Promise<void>;
}

// Setup winston logger
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: "wopr-plugin-provider-openai" },
  transports: [
    new winston.transports.Console({ level: "warn" })
  ],
});

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
 * Convert A2A server configs to Codex MCP server format
 * Codex expects: { name: { command, args, env } } or { name: { url } }
 */
function convertA2AToCodexMcpConfig(a2aServers: Record<string, A2AServerConfig>): Record<string, any> {
  const mcpServers: Record<string, any> = {};

  for (const [serverName, config] of Object.entries(a2aServers)) {
    // For A2A servers, we create a virtual MCP config
    // The actual tool execution is handled by WOPR's A2A system
    mcpServers[serverName] = {
      // Mark as WOPR-managed A2A server
      woprA2A: true,
      name: config.name,
      version: config.version || "1.0.0",
      tools: config.tools.map(t => t.name),
    };
    logger.info(`[codex] Registered A2A server: ${serverName} with ${config.tools.length} tools`);
  }

  return mcpServers;
}

/**
 * OpenAI Codex provider implementation
 */
const codexProvider: ModelProvider = {
  id: "codex",
  name: "OpenAI Codex",
  description: "OpenAI Codex agent SDK with A2A/MCP support",
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
      logger.error("[codex] Credential validation failed:", error);
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
 * Codex client implementation with A2A support
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

  async *query(opts: ModelQueryOptions): AsyncGenerator<unknown> {
    const client = await this.getClient();

    try {
      // Prepare prompt - include image URLs in text
      // Codex SDK vision is beta/buggy, so we include URLs in prompt instead
      let prompt = opts.prompt;
      if (opts.images && opts.images.length > 0) {
        const imageList = opts.images.map((url, i) => `[Image ${i + 1}]: ${url}`).join('\n');
        prompt = `[User has shared ${opts.images.length} image(s)]\n${imageList}\n\n${opts.prompt}`;
      }

      // Build run options
      const runOptions: any = {
        prompt,
        systemPrompt: opts.systemPrompt,
        directory: process.cwd(),
        ...opts.providerOptions,
      };

      // A2A MCP server support
      // Codex uses mcp_servers config for MCP integration
      if (opts.a2aServers && Object.keys(opts.a2aServers).length > 0) {
        runOptions.mcpServers = convertA2AToCodexMcpConfig(opts.a2aServers);
        logger.info(`[codex] A2A MCP servers configured: ${Object.keys(opts.a2aServers).join(", ")}`);
      }

      // Tools that are auto-allowed
      if (opts.allowedTools && opts.allowedTools.length > 0) {
        runOptions.enabledTools = opts.allowedTools;
        logger.info(`[codex] Allowed tools: ${opts.allowedTools.join(", ")}`);
      }

      // Use Codex agent for code execution
      const q = await client.run(runOptions);

      // Stream results from Codex agent
      for await (const msg of q) {
        yield msg;
      }
    } catch (error) {
      logger.error("[codex] Query failed:", error);
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
    } catch (error) {
      logger.error("[codex] Health check failed:", error);
      return false;
    }
  }
}

/**
 * Plugin export
 */
const plugin: WOPRPlugin = {
  name: "provider-openai",
  version: "1.1.0", // Bumped for A2A support
  description: "OpenAI Codex API provider for WOPR with A2A/MCP support",

  async init(ctx: WOPRPluginContext) {
    ctx.log.info("Registering OpenAI Codex provider...");
    ctx.registerProvider(codexProvider);
    ctx.log.info("OpenAI Codex provider registered (supports A2A/MCP)");

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
    logger.info("[provider-openai] Shutting down");
  },
};

export default plugin;
