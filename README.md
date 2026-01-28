# wopr-plugin-provider-openai

OpenAI Codex provider plugin for WOPR.

## Installation

```bash
wopr plugin install wopr-plugin-provider-openai
```

## Configuration

Add your OpenAI API key:

```bash
wopr providers add codex sk-...
```

## Usage

Create a session with Codex provider:

```bash
wopr session create my-session --provider codex
```

Or set provider on existing session:

```bash
wopr session set-provider my-session codex
```

## Supported Models

- `codex` (default) - OpenAI's coding agent

## Development

```bash
npm install
npm run build
```
