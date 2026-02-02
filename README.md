# wopr-plugin-provider-openai

[![npm version](https://img.shields.io/npm/v/wopr-plugin-provider-openai.svg)](https://www.npmjs.com/package/wopr-plugin-provider-openai)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![WOPR](https://img.shields.io/badge/WOPR-Plugin-blue)](https://github.com/TSavo/wopr)

OpenAI Codex provider plugin for [WOPR](https://github.com/TSavo/wopr).

> Part of the [WOPR](https://github.com/TSavo/wopr) ecosystem - Self-sovereign AI session management over P2P.

## Prerequisites

- Node.js LTS (v20+)
- WOPR installed and configured
- One of the following:
  - ChatGPT Plus or Pro subscription (for OAuth authentication)
  - OpenAI API key (for API authentication)

## Installation

### From GitHub (Recommended)

```bash
wopr plugin install github:TSavo/wopr-plugin-provider-openai
```

### From npm

```bash
wopr plugin install wopr-plugin-provider-openai
```

### Verify Installation

```bash
wopr plugin list
```

You should see `wopr-plugin-provider-codex` in the list.

## Authentication

The Codex plugin supports two authentication methods:

### Option 1: OAuth Authentication (ChatGPT Plus/Pro)

This is the recommended method if you have a ChatGPT Plus or Pro subscription.

#### Step 1: Install the Codex CLI

```bash
npm install -g @openai/codex
```

#### Step 2: Authenticate with Device Auth

For headless/terminal environments, use device authentication:

```bash
codex login --device-auth
```

This will display:
1. A URL to visit in your browser
2. A code to enter on that page

Open the URL in your browser, enter the code, and authorize access with your ChatGPT account.

#### Step 3: Verify Credentials

Credentials are saved to `~/.codex/auth.json`. Verify the file exists:

```bash
cat ~/.codex/auth.json
```

You should see something like:
```json
{
  "email": "your-email@example.com",
  "plan": "plus",
  "access_token": "...",
  "refresh_token": "...",
  "expires_at": "..."
}
```

### Option 2: API Key Authentication

If you have an OpenAI API key:

```bash
wopr providers add codex sk-your-api-key-here
```

Or set the environment variable:

```bash
export OPENAI_API_KEY=sk-your-api-key-here
```

## Verify Provider is Available

### Step 1: Restart the WOPR Daemon

```bash
wopr daemon restart
```

Or if not running:

```bash
wopr daemon start
```

### Step 2: Check Provider Health

```bash
wopr providers health-check
```

You should see:
```
codex: available
```

Or check all providers:

```bash
wopr providers list
```

## Usage

### Create a Session with Codex Provider

```bash
wopr session create my-session --provider codex
```

### Set Provider on Existing Session

```bash
wopr session set-provider my-session codex
```

### Inject a Message

```bash
wopr inject my-session "Hello, what can you help me with?"
```

## Supported Models

- `codex` (default) - OpenAI's coding agent

## Troubleshooting

### Provider Shows "Available: none"

1. **Check daemon logs:**
   ```bash
   tail -f ~/wopr/daemon.log
   ```

2. **Restart the daemon:**
   ```bash
   wopr daemon restart
   ```

3. **Verify credentials exist:**
   ```bash
   ls -la ~/.codex/auth.json
   ```

### OAuth Token Expired

If you see "Your access token could not be refreshed because your refresh token was already used":

```bash
codex login --device-auth
```

Then restart the daemon:

```bash
wopr daemon restart
```

### Plugin Not Loading

1. **Check plugin is enabled:**
   ```bash
   wopr plugin list
   ```

2. **Check plugin path:**
   ```bash
   cat ~/wopr/plugins.json
   ```

3. **Verify plugin directory exists:**
   ```bash
   ls -la ~/wopr/plugins/wopr-plugin-provider-codex/
   ```

### Debug Logging

Enable verbose logging by setting the log level:

```bash
export LOG_LEVEL=debug
wopr daemon restart
```

Then check the logs:

```bash
tail -f ~/wopr/daemon.log | grep codex
```

## Development

```bash
git clone https://github.com/TSavo/wopr-plugin-provider-openai.git
cd wopr-plugin-provider-openai
npm install
npm run build
```

### Run Tests

```bash
npm test
```

### Link for Local Development

```bash
npm link
cd ~/wopr
wopr plugin install file:../wopr-plugin-provider-openai
```

## License

MIT
