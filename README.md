# omp-kiro-provider

An [Oh My Pi](https://github.com/canstralien/oh-my-pi) extension that registers
Kiro as a streaming model provider. It supports OAuth-managed credentials, Kiro
CodeWhisperer-compatible requests, tool calls, and an optional `kiro-cli acp`
fallback when the direct endpoint rejects a request.

This project retains the MIT attribution of the original
[`pi-kiro-provider`](https://github.com/MasuRii/pi-kiro-provider) project.

## At a glance

| Capability | Support |
| --- | --- |
| Provider ID | `kiro` |
| Authentication | AWS Builder ID, Google, and GitHub OAuth |
| Streaming | AWS EventStream responses |
| Models | Kiro subscription catalog, including GPT-5.6 Terra, Luna, and Sol when entitled |
| Tool calls | Direct Kiro tool calls and ACP filesystem/terminal requests |
| Fallback | `kiro-cli acp` after direct `401` or `403` responses |

Model availability is determined by the authenticated Kiro account. A model
listed by the extension may still be unavailable to a particular subscription.

## Installation

### Published package

```bash
omp plugin install omp-kiro-provider
```

### Linked local checkout

```bash
omp plugin link ~/omp-plugins/omp-kiro-provider
```

Restart OMP after installing or linking the extension.

## Authenticate and select a model

Start the OAuth flow from OMP:

```text
/login kiro
```

Select AWS Builder ID, Google, or GitHub and complete the browser flow. OMP
owns the resulting credentials; the plugin does not persist OAuth tokens in its
source tree or configuration file.

Then select an available model, for example:

```text
/model kiro/auto
```

The bundled catalog also includes these GPT-5.6 model IDs when the Kiro account
is entitled to them:

```text
kiro/gpt-5.6-terra
kiro/gpt-5.6-luna
kiro/gpt-5.6-sol
```

## Tools and permissions

The direct Kiro endpoint receives the tools exposed by the active OMP session.
When the provider uses the ACP fallback, Kiro CLI can request the following ACP
client capabilities:

- `fs/read_text_file`, only when the OMP request exposes a read-capable tool.
- `fs/write_text_file`, only when it exposes a write-capable tool.
- `terminal/*`, only when it exposes an execution-capable tool such as `bash`.

Each ACP permission request is compared against the tools available to the OMP
request. The plugin selects an `allow_once` option only for an allowed request;
it selects `reject_once` otherwise. It never invents a permission option ID.
Terminal processes created through ACP are released when the prompt completes
or the fallback exits.

This means a model cannot gain terminal access merely because ACP fallback is
enabled. OMP must expose an execution tool for that request.

## ACP fallback

A direct Kiro request normally uses the configured CodeWhisperer-compatible
endpoint. If it receives a `401 Unauthorized` or `403 Forbidden` response and
`cliFallback` is enabled, the plugin starts the official Kiro CLI ACP transport
instead.

Before relying on this path, authenticate the CLI with the same Kiro account:

```bash
kiro-cli login
kiro-cli acp --help
```

The plugin invokes:

```text
kiro-cli acp [--agent <kiroCliAgent>]
```

The fallback does not read, copy, or save Kiro CLI tokens. The CLI remains
responsible for its own authenticated session.

To disable fallback explicitly:

```json
{
  "cliFallback": false
}
```

## Configuration

Defaults are sufficient for the standard Kiro endpoint. To customize them,
copy the example configuration:

```bash
cp config/config.example.json config.json
```

For a linked checkout, place `config.json` in the plugin root. For an npm
installation, keep configuration outside the package and set:

```bash
export OMP_KIRO_CONFIG="$HOME/.config/omp/kiro.json"
```

### Minimal configuration

```json
{
  "enabled": true,
  "debug": false,
  "providerId": "kiro",
  "displayName": "Kiro",
  "upstreamUrl": "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse",
  "endpoint": "codewhisperer",
  "cliFallback": true,
  "kiroCliPath": "kiro-cli",
  "requestTimeoutMs": 600000
}
```

### Configuration reference

| Key | Description |
| --- | --- |
| `enabled` | Enables the provider registration. |
| `debug` | Enables plugin diagnostic logging. Do not share logs without reviewing them. |
| `providerId` | OAuth and OMP provider identifier. Default: `kiro`. |
| `displayName` | Name shown by OMP. |
| `upstreamUrl` | Direct streaming endpoint URL. |
| `endpoint` | Endpoint format: `codewhisperer` or `amazonq`. |
| `apiKey` | Credential source. OAuth-managed credentials are preferred. Environment-token mode is supported but unmanaged. |
| `cliFallback` | Enables `kiro-cli acp` after a direct `401` or `403`. |
| `kiroCliPath` | Path or command name for the Kiro CLI executable. |
| `kiroCliAgent` | Optional profile passed as `kiro-cli acp --agent <profile>`. |
| `requestTimeoutMs` | Direct-stream and OAuth timeout in milliseconds. |
| `profileArn` | Optional Kiro profile ARN. |
| `headers` | Additional non-authorization request headers. |
| `models` | Replaces the bundled model catalog. |
| `modelDefaults` | Overrides defaults applied to models. |

Configured `Authorization` headers are deliberately removed. Authentication is
controlled by the OAuth provider or the configured credential source rather
than arbitrary request headers.

### Example with an agent profile

```json
{
  "cliFallback": true,
  "kiroCliPath": "/usr/local/bin/kiro-cli",
  "kiroCliAgent": "docs-no-mcp",
  "requestTimeoutMs": 600000
}
```

An explicit CLI agent profile is useful when a global Kiro CLI configuration
installs hooks or MCP servers that should not run for OMP fallback requests.

## Troubleshooting

### Direct requests return `401` or `403`

Run `/login kiro` again to refresh the OMP credential. If CLI fallback is
enabled, verify that the CLI is installed and authenticated:

```bash
command -v kiro-cli
kiro-cli login
```

If fallback is not desired, set `"cliFallback": false` and resolve the direct
Kiro entitlement or credential issue instead.

### ACP reports a closed socket

A closed ACP socket means the CLI process or its JSON-RPC connection ended
before the request completed. Check that `kiro-cli acp` starts successfully,
that the selected CLI agent exists, and that the agent can use the capabilities
advertised by OMP. Enable plugin debugging only long enough to capture the
failure, then inspect the resulting diagnostic log for the CLI stderr message.

### A model cannot read files, modify files, or run commands

Tool availability is controlled by the active OMP request. The model must be
given the corresponding read, write, or execution tool. ACP fallback advertises
only those capabilities, so a missing OMP tool results in a denied request by
design.

### A model is not listed or cannot be used

Kiro subscription entitlement determines availability. Confirm the Kiro account
used by both `/login kiro` and `kiro-cli login`, then select a model available to
that account.

## Development

Requirements:

- Node.js 20 or later
- npm

The test runner supports Node 26 workspaces where OMP dependencies expose
TypeScript and Bun-only source files: it transpiles those dependencies in a
temporary directory and provides test-only Bun/native compatibility shims. No
runtime or published-package shim is installed.

```bash
npm install
npm run typecheck
npm run lint
npm run test
npm run package:dry-run
```

`npm run check` runs the project's type checking, audit, tests, and build
command. Local OMP integration can be exercised after a link with:

```bash
omp plugin link "$(pwd)"
```

## Security note

The plugin sends prompts, tool results, and session metadata to Kiro services.
Review the source and use an account appropriate to the sensitivity of the
workspace. Kiro endpoints are not a public OpenAI-compatible API and may change
without notice.

## License

MIT
