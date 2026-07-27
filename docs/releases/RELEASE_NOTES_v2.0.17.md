## Pi-Feishu Bridge v2.0.17

Patch release on top of the first public **v2.0.16**: harden task lifecycle, inbound dedup, and same-chat busy handling.

### Compatibility

- **Pi:** `>=0.80.6 <0.81.0` (unchanged)
- **Transport:** CardKit v2 + `im_patch` fallback (unchanged)

### Changes since v2.0.16

- **Dual-key inbound dedup** — reduce duplicate Feishu event delivery handling
- **`taskTimeoutSec`** — hard timeout per agent turn (seconds); default **900**; abort when exceeded
- **`sameChatBusyPolicy`** — `queue` (default) or `interrupt` (abort current turn and keep only the latest message)
- **Empty-answer fallback text** — avoid blank completed cards when the model produces no visible answer
- **Unified inbound media path labels** — consistent resource path labeling for images/files/audio/video

### Config (optional)

```json
{
  "feishu": {
    "taskTimeoutSec": 900,
    "sameChatBusyPolicy": "queue"
  }
}
```

See `examples/settings.example.json` and README.

### Install

```bash
pi install ./pi-feishu-bridge-2.0.17.tgz
# or
git clone https://github.com/zxsctxx/pi-feishu-bridge.git
cd pi-feishu-bridge && git checkout v2.0.17
pi install .
```

Then `/feishu config reload` or restart Pi. Verify with `/feishu doctor` and `/status`.

### License

MIT
