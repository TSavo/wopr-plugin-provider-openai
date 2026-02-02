/**
 * WOPR Plugin: Codex Provider
 *
 * Provides Codex API access via the official @openai/codex-sdk.
 * Supports A2A tools, session resumption via thread IDs, and reasoning effort control.
 * Install: wopr plugin install wopr-plugin-provider-codex
 */
import winston from "winston";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
// Setup winston logger
const logger = winston.createLogger({
    level: "info",
    format: winston.format.combine(winston.format.timestamp(), winston.format.errors({ stack: true }), winston.format.json()),
    defaultMeta: { service: "wopr-plugin-provider-codex" },
    transports: [
        new winston.transports.Console({ level: "warn" })
    ],
});
let CodexSDK;
// =============================================================================
// Auth Detection - mirrors Anthropic plugin pattern
// =============================================================================
const CODEX_AUTH_FILE = join(homedir(), ".codex", "auth.json");
function loadCodexCredentials() {
    if (!existsSync(CODEX_AUTH_FILE))
        return null;
    try {
        const data = JSON.parse(readFileSync(CODEX_AUTH_FILE, "utf-8"));
        // Check for OAuth tokens first
        if (data.tokens?.access_token) {
            // Parse email from id_token JWT payload
            let email = "";
            let planType = "";
            try {
                const payload = JSON.parse(Buffer.from(data.tokens.id_token.split('.')[1], 'base64').toString());
                email = payload.email || "";
                planType = payload["https://api.openai.com/auth"]?.chatgpt_plan_type || "";
            }
            catch { }
            return {
                type: "oauth",
                accessToken: data.tokens.access_token,
                refreshToken: data.tokens.refresh_token,
                email,
                planType,
            };
        }
        // Check for API key
        if (data.OPENAI_API_KEY) {
            return {
                type: "api_key",
                apiKey: data.OPENAI_API_KEY,
            };
        }
        return null;
    }
    catch {
        return null;
    }
}
function getApiKeyFromEnv() {
    return process.env.OPENAI_API_KEY || null;
}
function getAuth() {
    // Check Codex CLI credentials first (like Anthropic checks Claude Code)
    const codexAuth = loadCodexCredentials();
    if (codexAuth)
        return codexAuth;
    // Fall back to environment variable
    const envKey = getApiKeyFromEnv();
    if (envKey && envKey.startsWith("sk-")) {
        return { type: "api_key", apiKey: envKey };
    }
    return null;
}
function hasCredentials() {
    return getAuth() !== null;
}
function getAuthMethods() {
    const codexAuth = loadCodexCredentials();
    const envKey = getApiKeyFromEnv();
    const hasEnvKey = !!envKey && envKey.startsWith("sk-");
    return [
        {
            id: "oauth",
            name: "ChatGPT Plus/Pro (OAuth)",
            description: "Use your ChatGPT subscription - no per-token costs",
            available: codexAuth?.type === "oauth",
            requiresInput: false,
            setupInstructions: codexAuth?.type === "oauth"
                ? [`Logged in as: ${codexAuth.email || "ChatGPT user"} (${codexAuth.planType || "plus"})`]
                : ["Run: codex login", "Then restart WOPR"],
            docsUrl: "https://chatgpt.com/",
        },
        {
            id: "env",
            name: "Environment Variable",
            description: "Use OPENAI_API_KEY from environment",
            available: hasEnvKey,
            requiresInput: false,
            setupInstructions: hasEnvKey
                ? [`Using key from OPENAI_API_KEY (${envKey.slice(0, 10)}...)`]
                : ["Set OPENAI_API_KEY environment variable"],
            docsUrl: "https://platform.openai.com/api-keys",
        },
        {
            id: "api-key",
            name: "API Key (manual)",
            description: "Enter API key directly - billed per token",
            available: true,
            requiresInput: true,
            inputType: "password",
            inputLabel: "OpenAI API Key",
            inputPlaceholder: "sk-...",
            docsUrl: "https://platform.openai.com/api-keys",
        },
    ];
}
function getActiveAuthMethod() {
    const auth = getAuth();
    if (auth?.type === "oauth")
        return "oauth";
    if (auth?.type === "api_key")
        return "api-key";
    return "none";
}
/**
 * Lazy load Codex SDK
 */
async function loadCodexSDK() {
    if (!CodexSDK) {
        try {
            const codex = await import("@openai/codex-sdk");
            CodexSDK = codex;
        }
        catch (error) {
            throw new Error("Codex SDK not installed. Run: npm install @openai/codex-sdk");
        }
    }
    return CodexSDK;
}
/**
 * Map temperature (0-1) to Codex reasoning effort
 * Lower temp = more deterministic = higher effort
 */
function temperatureToEffort(temp) {
    if (temp === undefined)
        return "medium";
    if (temp <= 0.2)
        return "xhigh";
    if (temp <= 0.4)
        return "high";
    if (temp <= 0.6)
        return "medium";
    if (temp <= 0.8)
        return "low";
    return "minimal";
}
/**
 * Codex provider implementation
 */
const codexProvider = {
    id: "codex",
    name: "Codex",
    description: "Codex agent SDK with OAuth, API key, session resumption",
    defaultModel: "", // SDK chooses default
    supportedModels: [], // Populated dynamically via listModels()
    // Onboarding helpers (like Anthropic)
    getAuthMethods,
    getActiveAuthMethod,
    hasCredentials,
    async validateCredentials(credential) {
        // Empty credential is valid if we have OAuth or env-based auth
        if (!credential || credential === "") {
            return hasCredentials();
        }
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
        }
        catch (error) {
            logger.error("[codex] Credential validation failed:", error);
            return false;
        }
    },
    async createClient(credential, options) {
        return new CodexClient(credential, options);
    },
    getCredentialType() {
        const active = getActiveAuthMethod();
        if (active === "oauth")
            return "oauth";
        return "api-key";
    },
};
/**
 * Codex client implementation with session resumption
 */
class CodexClient {
    credential;
    options;
    codex;
    authType;
    constructor(credential, options) {
        this.credential = credential;
        this.options = options;
        // Determine auth type (like Anthropic client)
        if (credential && credential.startsWith("sk-")) {
            this.authType = "api_key";
        }
        else {
            const auth = getAuth();
            if (auth?.type === "oauth") {
                this.authType = "oauth";
            }
            else if (auth?.type === "api_key") {
                this.authType = "api_key";
                this.credential = auth.apiKey || "";
            }
            else {
                this.authType = "none";
            }
        }
        logger.info(`[codex] Using auth: ${this.authType}`);
    }
    async getCodex() {
        if (!this.codex) {
            const { Codex } = await loadCodexSDK();
            const auth = getAuth();
            if (this.authType === "oauth" && auth?.accessToken) {
                // Use OAuth access token
                this.codex = new Codex({
                    accessToken: auth.accessToken,
                    ...this.options,
                });
                logger.info(`[codex] Initialized with OAuth (${auth.email || "user"})`);
            }
            else if (this.credential) {
                // Use API key
                this.codex = new Codex({
                    apiKey: this.credential,
                    ...this.options,
                });
                logger.info(`[codex] Initialized with API key`);
            }
            else {
                throw new Error("No valid credentials available. Run: codex login");
            }
        }
        return this.codex;
    }
    async *query(opts) {
        const codex = await this.getCodex();
        try {
            let thread;
            // Session resumption via thread ID
            if (opts.resume) {
                logger.info(`[codex] Resuming thread: ${opts.resume}`);
                thread = codex.resumeThread(opts.resume);
            }
            else {
                // Start new thread with options
                const threadOptions = {
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
                        }
                        else if (event.item.type === "reasoning") {
                            yield { type: 'reasoning', text: event.item.text };
                        }
                        else if (event.item.type === "command_execution") {
                            yield {
                                type: 'tool_use',
                                name: 'bash',
                                input: { command: event.item.command },
                                output: event.item.aggregated_output,
                                exit_code: event.item.exit_code,
                            };
                        }
                        else if (event.item.type === "file_change") {
                            yield {
                                type: 'tool_use',
                                name: 'file_change',
                                changes: event.item.changes,
                            };
                        }
                        else if (event.item.type === "mcp_tool_call") {
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
        }
        catch (error) {
            logger.error("[codex] Query failed:", error);
            throw new Error(`Codex query failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async listModels() {
        try {
            const codex = await this.getCodex();
            // Use SDK's model list endpoint
            const response = await codex.listModels();
            if (response?.items) {
                return response.items.map((m) => m.model || m.id);
            }
            // Fallback if response format is different
            if (Array.isArray(response)) {
                return response.map((m) => m.model || m.id || m.name || m);
            }
            return [];
        }
        catch (error) {
            logger.error("[codex] Failed to list models:", error);
            return [];
        }
    }
    async healthCheck() {
        try {
            const codex = await this.getCodex();
            const thread = codex.startThread();
            return !!thread;
        }
        catch (error) {
            logger.error("[codex] Health check failed:", error);
            return false;
        }
    }
}
/**
 * Plugin export
 */
const plugin = {
    name: "provider-codex",
    version: "2.0.0",
    description: "Codex agent SDK provider with OAuth and API key support",
    async init(ctx) {
        ctx.log.info("Registering Codex provider...");
        // Show auth status (like Anthropic)
        const activeAuth = getActiveAuthMethod();
        const authMethods = getAuthMethods();
        const activeMethod = authMethods.find(m => m.id === activeAuth);
        if (activeMethod?.available) {
            ctx.log.info(`  Auth: ${activeMethod.name}`);
            if (activeMethod.setupInstructions?.[0]) {
                ctx.log.info(`  ${activeMethod.setupInstructions[0]}`);
            }
        }
        else {
            ctx.log.info("  Auth: None configured");
            ctx.log.info("  Run: codex login (OAuth) or set OPENAI_API_KEY");
        }
        ctx.registerProvider(codexProvider);
        ctx.log.info("Codex provider registered");
        // Register config schema for UI (like Anthropic)
        const methods = getAuthMethods();
        ctx.registerConfigSchema("provider-codex", {
            title: "Codex",
            description: "Configure Codex authentication",
            fields: [
                {
                    name: "authMethod",
                    type: "select",
                    label: "Authentication Method",
                    options: methods.map(m => ({
                        value: m.id,
                        label: `${m.name}${m.available ? " ✓" : ""}`,
                    })),
                    default: getActiveAuthMethod(),
                    description: "Choose how to authenticate with Codex",
                },
                {
                    name: "apiKey",
                    type: "password",
                    label: "API Key",
                    placeholder: "sk-...",
                    required: false,
                    description: "Only needed for API Key auth method",
                },
                {
                    name: "defaultModel",
                    type: "text",
                    label: "Default Model",
                    placeholder: "(uses SDK default)",
                    required: false,
                    description: "Default model (leave empty for SDK default)",
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
    },
    async shutdown() {
        logger.info("[provider-codex] Shutting down");
    },
};
export default plugin;
