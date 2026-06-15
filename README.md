# Tokal

Tokal is a local version of [`junhoyeo/tokscale`](https://github.com/junhoyeo/tokscale), a locally running web and CLI tool for tracking token usage across OpenCode, Claude Code, OpenClaw, Pi, Codex, Gemini, Cursor, AmpCode, Factory Droid, Kimi, and more.

The main difference from upstream Tokscale is privacy. Tokal is focused on local analysis. You can run a local web UI and inspect your token usage without submitting data to the Tokscale servers.

## Features

- Local web UI for viewing your token usage on your own machine.
- CLI summaries, charts, exports, and cost estimates.
- Multi-client usage tracking across popular AI coding tools.
- Local-first workflow: no account, upload, leaderboard, or hosted database required for local viewing.
- Pricing-based cost estimation using model pricing metadata.

## Quick start

```bash
npm install
npm run build
node packages/cli/src/index.ts web
```

Or, after installing the CLI package locally, run.

```bash
tokscale web
```

The `web` command scans local usage data, starts a local-only web UI, and opens it in your browser. Use `--no-open` if you do not want the browser opened automatically:

```bash
tokscale web --no-open
```

## CLI usage

```bash
tokscale graph --no-spinner
tokscale clients --no-spinner
tokscale wrapped --no-spinner
```

You can filter or customize output with the same CLI flags supported by Tokscale.

## Supported clients

Tokal tracks local usage from OpenCode, Claude Code, OpenClaw, Pi, Codex, Gemini, Cursor, AmpCode, Factory Droid, Kimi, GitHub Copilot CLI, Qwen, Roo Code, Kilo, Goose, Warp, Cline, Zed, and other Tokscale-supported clients.

## Privacy

Tokal's primary feature is the local web UI. Your usage data is read from local files and displayed locally. You do not need to submit your data to Tokscale servers, create an account, or publish a leaderboard profile.

## Upstream

This project is based on [`junhoyeo/tokscale`](https://github.com/junhoyeo/tokscale). Tokscale's original hosted leaderboard and submission workflow remain part of upstream; Tokal emphasizes local-only usage.

## License

MIT
