# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Tactual, please report it privately via [GitHub Security Advisories](https://github.com/tactual-dev/tactual/security/advisories/new) or email [security@tactual.sh](mailto:security@tactual.sh).

Do not open a public issue for security vulnerabilities.

Expect acknowledgement within 48 hours. Critical issues are prioritized for a fix or mitigation within 7 days.

## Threat Model

Tactual launches a Chromium browser, navigates to user-specified URLs, and captures the accessibility tree. The threat surface is:

### URLs and navigation

- **URL validation** (`src/core/url-validation.ts`): Blocks `javascript:`, `data:`, `vbscript:`, `blob:` schemes. Blocks embedded credentials (phishing vectors). Requires hostname for HTTP/HTTPS URLs.
- **`file:///` URLs**: Allowed by design (local fixture testing). Playwright's browser sandbox limits file system access to what Chromium permits.

### CSS selector injection

- **`excludeSelector` parameter**: Passed to `querySelectorAll()` inside `page.evaluate()`. Sanitized against `{}`, `javascript:`, `url()`, `@import`, `expression()` patterns before execution.
- **Limitation**: The regex-based blocklist may not catch all CSS injection patterns. Only use `excludeSelector` with trusted input.

### Exploration safety

- **Safe-action policy** (`src/playwright/safety.ts`): During explore mode, Tactual clicks interactive elements to discover hidden UI. The safe-action policy blocks activation of elements matching destructive patterns: delete, remove, purchase, checkout, logout, unsubscribe, etc.
- **Limitation**: The policy uses keyword matching on element names and roles. It cannot detect semantic deception (a button labeled "Show details" that actually deletes data). Only run explore mode on trusted or sandboxed environments.

### Browser sandboxing

- Chromium always launches with default sandboxing enabled.
- Web security is never disabled.
- No browser flags are modified.

### HTTP transport

- The `--http` transport binds to `127.0.0.1` by default (localhost only). Network exposure requires explicitly setting `--host=0.0.0.0` or `HOST=0.0.0.0`.
- No authentication or TLS. The HTTP transport is intended for local development and trusted container environments, not public exposure. Use a reverse proxy with TLS and auth for any network-facing deployment.
- Request body size is not capped. Malicious clients could send arbitrarily large payloads.

### Output safety

- **SARIF output**: User-controlled content (target names, penalty text) is serialized via `JSON.stringify()`, which handles escaping. No raw string interpolation into SARIF structure.
- **File writes**: The `--output` CLI flag writes to user-specified paths. No path traversal protection beyond what Node.js `fs.writeFile()` provides.

## Supported Versions

| Version | Supported |
|---|---|
| 0.2.x | Yes (current) |
| 0.1.x | No |

## Dependencies

Runtime dependencies: `commander` (CLI parsing), `zod` (schema validation).

Peer dependencies (optional): `playwright` (browser automation), `@modelcontextprotocol/sdk` (MCP server).

Run `npm audit` to check for known vulnerabilities in the dependency tree.
