/**
 * WOPR Plugin: Codex Provider
 *
 * Provides Codex API access via the official @openai/codex-sdk.
 * Supports A2A tools, session resumption via thread IDs, and reasoning effort control.
 * Install: wopr plugin install wopr-plugin-provider-codex
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
  defaultMeta: { service: "wopr-plugin-provider-codex" },
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
 * Map temperature (0-1) to Codex reasoning effort
 * Lower temp = more deterministic = higher effort
 */
function temperatureToEffort(temp?: number): "minimal" | "low" | "medium" | "high" | "xhigh" {
  if (temp === undefined) return "medium";
  if (temp <= 0.2) return "xhigh";
  if (temp <= 0.4) return "high";
  if (temp <= 0.6) return "medium";
  if (temp <= 0.8) return "low";
  return "minimal";
}

/**
 * Codex provider implementation
 */
const codexProvider: ModelProvider = {
  id: "codex",
  name: "Codex",
  description: "Codex agent SDK with session resumption and A2A support",
  defaultModel: "", // SDK chooses default
  supportedModels: [], // Populated dynamically via listModels()

  async validateCredentials(credential: string): Promise<boolean> {
    // API key format: sk-... (OpenAI format)
    if (!credential.startsWith("sk-")) {
      return false;
    }

    try {
      const { Codex } = await loadCodexSDK();
      const codex = new Codex({ apiKey: credential });
      // Start a minimal thread to validate
      const thread = codex.startThread();
      // Thread creation succeeds if credentials are valid
      return !!thread;
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
 * Codex client implementation with session resumption
 */
class CodexClient implements ModelClient {
  private codex: any;

  constructor(
    private credential: string,
    private options?: Record<string, unknown>
  ) {}

  private async getCodex() {
    if (!this.codex) {
      const { Codex } = await loadCodexSDK();
      this.codex = new Codex({
        apiKey: this.credential,
        ...this.options,
      });
    }
    return this.codex;
  }

  async *query(opts: ModelQueryOptions): AsyncGenerator<unknown> {
    const codex = await this.getCodex();

    try {
      let thread: any;

      // Session resumption via thread ID
      if (opts.resume) {
        logger.info(`[codex] Resuming thread: ${opts.resume}`);
        thread = codex.resumeThread(opts.resume);
      } else {
        // Start new thread with options
        const threadOptions: any = {
          workingDirectory: process.cwd(),
          sandboxMode: "workspace-write",
          approvalPolicy: "never", // YOLO mode - auto-approve
        };

        // Model selection
        if (opts.model) {
          threadOptions.model = opts.model;
        }

        // Map temperature to reasoning effort
        threadOptions.modelReasoningEffort = temperatureToEffort(opts.temperature);
        logger.info(`[codex] Reasoning effort: ${threadOptions.modelReasoningEffort}`);

        // Merge provider options
        if (opts.providerOptions) {
          Object.assign(threadOptions, opts.providerOptions);
        }

        thread = codex.startThread(threadOptions);
      }

      // Yield thread ID for session tracking (feature parity with Anthropic)
      if (thread.id) {
        yield { type: 'session_id', session_id: thread.id };
        logger.info(`[codex] Thread ID: ${thread.id}`);
      }

      // Prepare prompt with images if provided
      let prompt = opts.prompt;
      if (opts.images && opts.images.length > 0) {
        const imageList = opts.images.map((url, i) => `[Image ${i + 1}]: ${url}`).join('\n');
        prompt = `[User has shared ${opts.images.length} image(s)]\n${imageList}\n\n${opts.prompt}`;
      }

      // Add system prompt context if provided
      if (opts.systemPrompt) {
        prompt = `[System: ${opts.systemPrompt}]\n\n${prompt}`;
      }

      // Use streaming to get real-time events
      const { events } = await thread.runStreamed(prompt);

      for await (const event of events) {
        switch (event.type) {
          case "thread.started":
            yield { type: 'system', subtype: 'init', thread_id: event.thread_id };
            break;

          case "turn.started":
            yield { type: 'system', subtype: 'turn_start' };
            break;

          case "item.completed":
            // Handle different item types
            if (event.item.type === "agent_message") {
              yield { type: 'text', text: event.item.text };
            } else if (event.item.type === "reasoning") {
              yield { type: 'reasoning', text: event.item.text };
            } else if (event.item.type === "command_execution") {
              yield {
                type: 'tool_use',
                name: 'bash',
                input: { command: event.item.command },
                output: event.item.aggregated_output,
                exit_code: event.item.exit_code,
              };
            } else if (event.item.type === "file_change") {
              yield {
                type: 'tool_use',
                name: 'file_change',
                changes: event.item.changes,
              };
            } else if (event.item.type === "mcp_tool_call") {
              yield {
                type: 'tool_use',
                name: `mcp__${event.item.server}__${event.item.tool}`,
                status: event.item.status,
              };
            }
            break;

          case "turn.completed":
            yield {
              type: 'usage',
              input_tokens: event.usage?.input_tokens,
              output_tokens: event.usage?.output_tokens,
            };
            break;

          case "turn.failed":
            yield { type: 'error', message: event.error?.message };
            break;
        }
      }
    } catch (error) {
      logger.error("[codex] Query failed:", error);
      throw new Error(
        `Codex query failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const codex = await this.getCodex();
      // Use SDK's model list endpoint
      const response = await codex.listModels();
      if (response?.items) {
        return response.items.map((m: any) => m.model || m.id);
      }
      // Fallback if response format is different
      if (Array.isArray(response)) {
        return response.map((m: any) => m.model || m.id || m.name || m);
      }
      return [];
    } catch (error) {
      logger.error("[codex] Failed to list models:", error);
      return [];
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const codex = await this.getCodex();
      const thread = codex.startThread();
      return !!thread;
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
  name: "provider-codex",
  version: "2.0.0",
  description: "Codex agent SDK provider for WOPR",

  async init(ctx: WOPRPluginContext) {
    ctx.log.info("Registering Codex provider...");
    ctx.registerProvider(codexProvider);
    ctx.log.info("Codex provider registered (session resumption, reasoning effort)");

    // Register config schema for UI
    ctx.registerConfigSchema("provider-codex", {
      title: "Codex",
      description: "Configure Codex API credentials",
      fields: [
        {
          name: "apiKey",
          type: "password",
          label: "API Key",
          placeholder: "sk-...",
          required: true,
          description: "Your Codex API key (starts with sk-)",
        },
        {
          name: "defaultModel",
          type: "text",
          label: "Default Model",
          placeholder: "(uses SDK default)",
          required: false,
          description: "Default model (leave empty for SDK default, or specify model from listModels())",
        },
        {
          name: "reasoningEffort",
          type: "select",
          label: "Reasoning Effort",
          required: false,
          description: "How much effort the model puts into reasoning",
          options: [
            { value: "minimal", label: "Minimal (fastest)" },
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium (default)" },
            { value: "high", label: "High" },
            { value: "xhigh", label: "Extra High (most thorough)" },
          ],
          default: "medium",
        },
      ],
    });
    ctx.log.info("Registered Codex config schema");
  },

  async shutdown() {
    logger.info("[provider-codex] Shutting down");
  },
};

export default plugin;
