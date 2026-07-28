## Pi-Feishu Bridge v2.0.18

Compatibility release: expand Pi peer range to include 0.81.x.

### Compatibility

- **Pi:** `>=0.80.6 <0.82.0` (was `>=0.80.6 <0.81.0`)
- **Verified against:** `@earendil-works/pi-coding-agent@0.81.1`
- **Transport:** CardKit v2 + `im_patch` fallback (unchanged)

### Changes since v2.0.17

- **Peer range** — allow Pi 0.81.x; keep lower bound at 0.80.6
- **devDependency** — pin `@earendil-works/pi-coding-agent` to `^0.81.1` for local typecheck/tests

### API surface used (still present in 0.81.1)

- `ExtensionAPI`: `on`, `registerFlag`, `registerCommand`, `registerTool`, `setModel`, `getSessionName`
- Events: `message_update` (`text_delta` / `thinking_delta` / `error`), `before_agent_start`, `after_provider_response`, `message_end`, `tool_execution_*`, `agent_end`, `agent_settled`, `session_compact`, `session_start`, `session_shutdown`
- `AgentSession.prototype.sendUserMessage` / `prompt` (internal command patch)
- `SessionManager.list` / `listAll`, session id/name/file getters
- `ExtensionCommandContext`: `newSession`, `switchSession`, `reload`, `abort`, `waitForIdle`

No runtime code changes required for 0.81.1 beyond the peer declaration.

### Install

```bash
pi install ./pi-feishu-bridge-2.0.18.tgz
# or from this directory
pi install .
```

Then `/feishu config reload` or restart Pi. Verify with `/feishu doctor` and `/status`.

### License

MIT
