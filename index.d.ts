/**
 * WOPR Plugin: Codex Provider
 *
 * Provides Codex API access via the official @openai/codex-sdk.
 * Supports A2A tools, session resumption via thread IDs, and reasoning effort control.
 * Install: wopr plugin install wopr-plugin-provider-codex
 */
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
    options?: Array<{
        value: string;
        label: string;
    }>;
    default?: unknown;
}
interface ConfigSchema {
    title: string;
    description: string;
    fields: ConfigField[];
}
interface WOPRPluginContext {
    log: {
        info: (msg: string) => void;
    };
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
export interface AuthMethodInfo {
    id: string;
    name: string;
    description: string;
    available: boolean;
    requiresInput: boolean;
    inputType?: "password" | "text";
    inputLabel?: string;
    inputPlaceholder?: string;
    setupInstructions?: string[];
    docsUrl?: string;
}
/**
 * Plugin export
 */
declare const plugin: WOPRPlugin;
export default plugin;
