## Pi-Feishu Bridge v2.0.16

First public GitHub release of **pi-feishu-bridge**: Feishu/Lark as a controlled chat entry for Pi coding agent (`@earendil-works/pi-coding-agent`).

### Compatibility

- **Pi:** `>=0.80.6 <0.81.0` (peer dependency; not auto-matched to 0.81+)
- **Transport:** CardKit v2 native streaming (with `im_patch` fallback)

### Highlights

- CardKit `card.create` + element-level streaming; thinking/tools on a unified timeline
- Default **allowlist** access policy (empty list = deny all); `open` only for local dev
- Feishu slash commands: `/new`, `/resume`, `/name`, `/session`, `/reload`, `/compact`, `/model`, `/stop`, `/queue`, `/status`, `/help`, `/feishu …`
- Tools: `send_to_feishu`, `send_image_to_feishu`, `send_file_to_feishu`, `ask_feishu`
- Footer metrics: model, tokens, cost, cache, context, API calls, stop reason

### Install

```bash
# from this release asset
pi install ./pi-feishu-bridge-2.0.16.tgz

# or clone and install from path
git clone https://github.com/zxsctxx/pi-feishu-bridge.git
pi install ./pi-feishu-bridge
```

Configure `feishu` in `~/.pi/agent/settings.json` (see README / `examples/settings.example.json`), then start Pi and use `/feishu doctor`.

### Credits

Early channel work evolved from [surenkid/pi-feishu](https://github.com/surenkid/pi-feishu). CardKit streaming design references [Aowen-Nowor/hermes-lark-streaming](https://github.com/Aowen-Nowor/hermes-lark-streaming). See README for details.

### License

MIT
