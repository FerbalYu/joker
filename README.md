# JOKER

AI coding agent desktop app — a Claude Code / Codex Desktop-style application built with Electron + React + TypeScript.

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 43.2.0 + electron-vite |
| Language | TypeScript 5 (strict) |
| Frontend | React 19 + Tailwind v4 + Zustand |
| Agent core | Vercel AI SDK 7 (`streamText`) |
| Providers | Existing OpenAI / Anthropic / Ollama / OpenAI-compatible support |
| MCP | `@modelcontextprotocol/sdk` |
| Streaming IPC | `MessageChannelMain` + `MessagePort` |
| Persistence | JSON files in `~/.joker/sessions/` |

## Architecture

```text
src/
├── main/                         # Electron main process
│   ├── index.ts                  # App entry and window creation
│   ├── stream.ts                 # MessagePort + session-aware stream routing
│   ├── agent/loop.ts             # streamText tool loop
│   ├── agent/approval.ts         # Approval gate and request lifecycle
│   ├── providers/                # Provider/model abstraction
│   ├── store/config.ts           # ~/.joker/config.json
│   ├── store/sessions.ts         # ~/.joker/sessions/*.json
│   └── tools/                    # Built-in tools + MCP bridge
├── preload/index.ts              # contextBridge security boundary
├── renderer/src/
│   ├── App.tsx                   # Session lifecycle and stream event routing
│   ├── store.ts                  # Zustand chat/session/transient state
│   └── components/               # Sidebar / MessageStream / DetailPanel / InputBox
└── shared/types.ts               # Shared messages, sessions, stream and approval types
```

## Runtime data flow

```text
Sidebar/App
  └─ session.list/create/get/append/delete/rename
       └─ Zustand activeSessionId + messages
            └─ chat.send(sessionId, messages)
                 └─ MessagePort
                      └─ main stream.ts
                           └─ runAgent({ sessionId, ... })
                                └─ ToolContext.sessionId / Todo / approval request
                                     └─ session-aware StreamEvent back to renderer
```

The renderer ignores stream and approval events that belong to another session. User messages are persisted before a request is sent; completed assistant messages and error messages are persisted when received.

The composer remains visible at the bottom of the chat. Approval mode and reasoning level use compact icon controls with accessible labels and tooltips. Token counts are intentionally not rendered inline in the conversation.

Clipboard images are accepted as PNG, JPEG, WebP, or GIF attachments. Before an image enters React state, session JSON, IPC, or a model request, the renderer checks its decoded dimensions and proportionally scales any image whose longest side exceeds 1280px; smaller images are not enlarged. Input thumbnails use `object-cover`, message images use `object-contain`, and either can be clicked to open a viewport-limited preview. The resize path uses Chromium's native `createImageBitmap` and Canvas APIs rather than an image-processing plugin. Oversized GIFs are converted to a static PNG during resize; GIFs within the limit are kept unchanged. Each image remains limited to 5 MB, with four images and 10 MB total per message.

## Status

Detailed status is tracked in [`MILESTONES.md`](./MILESTONES.md).

- [x] M1: Skeleton + streaming chat
- [x] M2: Tool system + approval gate (implemented and key paths tested)
- [x] M3: Multi-provider + MCP + sub-agents (implemented; limited end-to-end verification)
- [x] M4: Session persistence + context compaction foundation
- [x] Session UI create/load/switch/rename/delete and message persistence
- [x] Session ID propagation through Agent and tool context
- [x] Real-state DetailPanel
- [x] Key unit tests
- [x] Chat-area token usage (input/output/total/cache) persisted on assistant messages
- [x] Reasoning level selector (Auto/Off/Low/Medium/High) with Ctrl+T cycling and request propagation
- [x] Persistent bottom composer with icon-based approval/reasoning controls
- [x] Clipboard image paste with previews and multimodal message conversion
- [x] MCP server persistence, startup restore, schema-aware tool bridge, and shared approval path
- [x] Explicit local Skill discovery, enable/disable, and Agent instruction injection
- [x] WebRead tool with HTTP-first reading and browser-rendering fallback
- [x] ToolForge: autonomous capability-gap detection, ForgeAgent tool manufacturing, host-side validation, hot reload, and original-task continuation
- [x] ToolForge management & edit: Settings self-made-tool page with version/policy/validation evidence and natural-language directed edits

## Configuration

Set API keys and models in Settings. Chat providers remain in `~/.joker/config.json`. Dedicated text-to-image providers are stored separately in `~/.joker/image-provider.json`, support multiple OpenAI Images / Grok-compatible entries plus an active image provider, and never appear in the chat model selector. Existing single-image-provider files are migrated in memory and written in the new collection format on the next save. The existing multi-provider chat configuration is stored in `~/.joker/config.json`:

```json
{
  "providers": [
    {
      "id": "openai-default",
      "name": "OpenAI",
      "type": "openai",
      "apiFormat": "chat-completions",
      "modelsPath": "/v1/models",
      "enabled": true,
      "models": [
        {
          "id": "gpt-4o",
          "name": "gpt-4o",
          "enabled": true,
          "maxContextTokens": 262144
        }
      ],
      "currentModelId": "gpt-4o"
    }
  ],
  "activeProviderId": "openai-default"
}
```

`maxContextTokens` is the model-level input context budget. Automatic compression is always enabled and triggers when the estimated context approaches the configured budget. Leave room for system prompts, tools, MCP schemas, Skills, and output tokens; the estimate is not an exact provider tokenizer.

MCP is available as an external tool bridge. Server definitions are persisted in `~/.joker/config.json`; stdio and HTTP transports can be configured from Settings, restored on application startup, and disconnected on exit. MCP tools keep their input schema, use stable namespaced IDs, and pass through the same approval gate as built-in tools. Configured servers default to `untrusted` + `deny`; a durable identity fingerprint is required before connect, identity changes revoke trust, server permission remains enforced independently of approval/full-auto mode, and only trusted/allowed tools enter the Agent tool set. Runtime lifecycle is bounded by initialize/call deadlines, generation-fenced crash recovery, process-tree cleanup, and a redacted JSONL audit sink. HTTP headers and other credentials must not be logged.

Skills are trusted Markdown instruction packages discovered from the built-in `skills/` directory, `~/.joker/skills/`, or the read-only external Agent Skills directory `C:\Users\ecgoi\.agents\skills\`. External `SKILL.md` files may omit `id`; JOKER uses the containing folder name as the stable ID. A skill uses frontmatter (`id`, `name`, `description`, optional `version` and `allowedMcpTools`) followed by instructions. Skills are explicitly enabled from Settings and injected as workflow guidance only; they do not execute scripts, grant tool permissions, or bypass approval. Disabling an external Skill only removes its ID from JOKER's enabled list; JOKER never deletes or modifies files under `C:\Users\ecgoi\.agents\skills\`. MCP and skill content are included in the request context budget.

WebRead is a built-in external-network tool for reading public webpages. It uses a bounded HTTP fetch first and falls back to an isolated Playwright browser with the installed Chrome or Edge executable when the page is JavaScript-rendered or the static response is not useful. WebRead only accepts public `http://` and `https://` URLs, blocks local/private network targets, does not send login cookies or arbitrary headers, limits redirects, time, response size, and returned text, and keeps webpage content as untrusted source material. The real Chrome/Edge loopback dynamic contract is conditional on an installed browser and is not a default CI browser gate; environments without a supported executable explicitly skip that browser case. In `suggest` and `auto-edit` modes it requires approval; `full-auto` may run it automatically. It does not guarantee access to login walls, CAPTCHA challenges, or every dynamic site.


| Command | Description |
|---|---|
| `npm run dev` | Start the Electron development app |
| `npm run typecheck` | Type-check main, preload, shared, and renderer code |
| `npm run lint` | Run the repository's minimal source-hygiene lint (not a stylistic ESLint replacement) |
| `npm run test` | Run the deterministic unit-test suite |
| `npm run test:unit` | Run the deterministic unit-test suite explicitly |
| `npm run test:integration` | Run deterministic integration-boundary tests with local fake Provider, MCP stdio/HTTP, and WebRead loopback fixtures; never calls real Provider/MCP services |
| `npm run test:integration:mcp` | Run the local MCP stdio/Streamable HTTP wire-contract tests |
| `npm run test:web:contract` | Run WebRead static, redirect, unsupported-content, fallback, truncation, abort, and conditional real Chrome/Edge dynamic-rendering contract tests |
| `npm run test:e2e:electron` | Build and run the repeatable isolated Electron smoke harness; writes a temporary JSON report and screenshots |
| `npm run test:e2e:electron:approval` | Build and run the opt-in two-window Electron approval harness; verifies window-scoped approval resolution and close cancellation with a fake Provider |
| `npm run test:qualification:stream` | Build and run the opt-in Windows Electron MessagePort stream qualification harness with burst, slow-consumer, abort, bounded ACK/credit flow-control, and JSON evidence output; not a CI gate or byte-level memory SLA |
| `npm run test:qualification:release-boundaries` | Audit Windows artifact/lifecycle evidence, Authenticode status, and explicit macOS/Linux native-platform skips; writes a temporary JSON report |
| `npm run test:qualification:session-concurrency` | Run isolated multi-process session append contention qualification; reports pass/fail/inconclusive without using real user data |
| `npm run test:qualification:mcp` | Run the credential-free manager-driven local MCP lifecycle qualification for trust, permission, deadlines, crash recovery, generation fencing, descendant cleanup, remove-after-close-error, and redacted audit; no external MCP provider is contacted |
| `npm run test:e2e:electron:mcp-settings` | Build and run the isolated Electron Settings MCP qualification for Trust/Revoke, Allow/Deny, Reconnect, tool exposure, and restart persistence |
| `npm run test:qualification:native-package` | Run native DMG/AppImage/deb install/startup/session qualification on the corresponding macOS/Linux runner; Windows reports explicit platform skips and is not native evidence |
| `npm run test:qualification:signed-release` | Run fail-closed platform signing and independent verification; requires platform credentials and never records secret values |

| `npm run build` | Build main, preload, and renderer bundles |
| `npm run build:dist` | Build `out/` and package a distributable with electron-builder (Windows icon: `src/image/logo.ico`) |

## Security and P0–P2 verification boundaries

- **P0 safety boundary:** session files use a versioned envelope, a cross-process per-session transaction lock directory with stale-owner recovery, temporary-file + backup recovery, validation, and best-effort `fsync`; Windows replacement still has a documented unlink/rename crash window. Approval responses are isolated by `windowId + sessionId + runId`, and cancellation denies pending requests.
- **P1 capability boundary:** Skills are explicitly enabled trusted Markdown guidance and cannot grant permissions or bypass approval. MCP tools are exposed only through exact Skill allowlists when a Skill constraint exists; an empty allowlist grants none. External Agent Skills are read-only to JOKER. Sub-agents receive only Read/Grep/Glob/Git read-only tools and cannot write, run Bash, access WebRead/WebSearch, use image tools, or access MCP.
- **P1b Generated Tool boundary:** ToolForge self-made tools run in a dedicated Node child process (`fork`), not in the Electron main-process address space. They use the `user-owned-full-trust-v1` profile: the child process isolates cancellation only and is **not** a capability or policy boundary — generated code runs with the current desktop user's account permissions, and the policy engine returns `allow` without an approval or permission gate. ForgeAgent can only manufacture; the host Validator independently verifies behavior, path/privilege-escalation probes, timeout/cancellation/process-tree cleanup, and audit evidence before a tool becomes available. Generated tools cannot call JOKER IPC, mutate the Tool Registry, or write audit files. Content or permission changes invalidate a version and require re-validation; versions are immutable and can be rolled back, disabled, or deleted. A deny-only execution guard re-verifies the live registry binding (fingerprint, pointer/capability revision, active version) at the final execution boundary of every call; the execution adapter performs the same re-verification internally. See [`TOOL-FORGE-PLAN.md`](./TOOL-FORGE-PLAN.md) §0 for the authoritative description.
- **P1c file concurrency boundary:** `Read` returns a SHA-256 content `version` in its metadata. `Edit` and `Write` accept an optional `expectedVersion`; when provided and the current file content digest no longer matches, the call fails with an `expectedVersion mismatch` error instead of overwriting, forcing the model to re-read. `Write` creates new files and overwrites existing ones as before when no version is supplied.
- **P1d tool lifecycle boundary:** tool execution records a causal per-session operation journal (`<sessionId>.operations.jsonl`) with `tool-started` durably written before the tool body runs and `tool-result` after it settles. On restart, a run that never recorded `run-terminal` is classified per tool: `TOOL_NOT_STARTED` (intent durable, body never ran — safe to re-issue) versus `TOOL_OUTCOME_UNKNOWN` (body started, no result — never auto-retry; the next run's system prompt is annotated so the model checks state or asks the user). Tool timeouts and cancellations abort the tool signal and then wait for the tool to actually settle within a bounded grace period (5s default, per-tool `quiescenceGraceMs`) before reporting the terminal state, instead of abandoning the still-running tool.
- **P2 engineering boundary:** CI validates typecheck, minimal lint, unit tests, deterministic local integration contracts, coverage output/manifest, and Electron bundle build on the current Windows runner. No CI job calls real Provider/MCP/network services. Windows v0.1.0 → v0.1.1 install/upgrade/uninstall retention and packaged UI startup were separately validated in isolated directories. Linux AppImage/deb install, startup, session restoration, uninstall, and cleanup have separate Ubuntu 22.04 WSL2 evidence under `.qa/native-linux-wsl-20260729/`; that local evidence is not a hosted GitHub Actions artifact, and the current `.github/workflows/ci.yml` runs a single Windows `verify` job. macOS packaged startup remains unavailable in the current Windows environment, and hosted native-runner evidence still requires a repository remote and CI dispatch access.

The opt-in `npm run test:qualification:stream` command launches a real Windows Electron renderer and transferred MessagePort against a loopback fast-stream Provider. The transport uses an application-level ACK/credit window with a 32-event high-water mark and a 3-event terminal reserve; `queueDepth` is defined as pending plus in-flight envelopes, and `drain` means that depth returns to zero. The harness records FIFO delivery, slow-consumer delay, abort terminal events, ACK counts, blocked/resumed sends, queue maxima, drain events, renderer memory when available, provider statistics, and process output in a temporary JSON report. `--strict` requires the observed bound, complete ACK reconciliation, exercised blocked/resumed/drain behavior, and zero late events. This is local Windows qualification evidence, not a byte-level memory SLA, production soak guarantee, CI gate, or cross-platform verification.

The automated tests use local fixtures and mocked `fetch` implementations where needed. They do not call real external Providers, MCP servers, or credentials. The integration boundary is real: it runs the fake Provider HTTP contract, MCP stdio and loopback Streamable HTTP wire contracts, WebRead loopback contracts, approval/capability contracts, and writes no external artifacts. The real browser WebRead case runs only when a supported local Chrome or Edge executable is available; missing browsers produce an explicit skip, and CI does not guarantee a browser installation. The Windows runner now includes the session-store, generated-image, and WebRead unit tests; the session tests use best-effort fsync and deterministic temp/backup recovery assertions. The Electron harness is opt-in and runs against an isolated `JOKER_HOME`; it is not part of default CI. `test:coverage` uses Node's built-in experimental coverage, prints the measured table, and writes an auditable exact-test-set manifest to `coverage/test-manifest.json`; it does not invent a percentage or silently pass. CI runs typecheck, lint, unit, deterministic integration, coverage, and Electron bundle build on the current Windows runner, uploading coverage and `out/` artifacts; CI does not launch Electron or invoke external services.

The current boundary audit also records the remaining release limits: Windows NSIS artifact/lifecycle evidence can be audited, but the current artifact is unsigned (`NotSigned` and `signAndEditExecutable: false`); macOS/Linux native install/startup/signing are explicit `skip`/`not-verified` statuses on this Windows host. Native qualification must run with `--strict` on the corresponding runner and writes its report under `JOKER_NATIVE_REPORT_DIR`; signed qualification uses `JOKER_SIGNED_REPORT_DIR`, requires real credentials, independently verifies signatures, and fails closed when credentials or verification are missing. `npm run test:qualification:session-concurrency` uses independent local processes and now verifies cross-process per-session append serialization: the latest 4-worker × 30-round run passed with 120 acknowledged updates, 120 final messages, zero missing IDs, valid envelope/backup, and no temporary or lock residue. `npm run test:qualification:mcp` now drives the real manager against isolated local fixtures and the latest run passed 15/15 checks, including trust/permission, initialize/call timeout, crash state, cleanup, remove fencing, and audit redaction. The Electron Settings MCP qualification passed 11/11 checks for Trust/Revoke, Allow/Deny, Reconnect, tool exposure, and restart persistence. These MCP, Settings, and session reports preserve exact commands, isolated run directories, and no-credential fixture evidence.

On this Windows workspace, commands are run from Git Bash. The Bash tool used by the application executes with `shell: true` and is intentionally non-sandboxed at the application level; CI is a separate non-interactive validation environment and does not exercise arbitrary Bash, Provider, MCP, or network tool calls.
