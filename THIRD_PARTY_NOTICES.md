# Third-party sources and licenses

The original bridge implementation, CLI, protocol and project documentation are licensed under the root MIT License.

## DS Bot

- Upstream: https://github.com/Fei2411/DS-Bot
- Reviewed compatibility baseline: v0.2.7
- Copyright 2026 Fei2411 and the DS Bot contributors
- Upstream license: Apache License, Version 2.0
- Preserved upstream license: [assets/bridge/LICENSE-DS-Bot.txt](assets/bridge/LICENSE-DS-Bot.txt)
- Preserved upstream attribution notice: [assets/bridge/NOTICE-DS-Bot.txt](assets/bridge/NOTICE-DS-Bot.txt)

This repository does not ship DS Bot itself, its browser client, its credentials or its instance data. The compatibility package metadata describes the original frontend registration contract. At explicitly approved installation, the installer reads the recipient's existing `app.asar`, extracts the pinned original browser client and copies it byte-for-byte. That extracted client remains governed by its upstream license; the root MIT License does not relicense it.

The deployed local wrapper includes its own MIT license and a copy of these upstream license/notice files. The wrapper resolves original Host dependencies from the existing DS Bot installation. Those dependencies keep their respective licenses and are not installed or redistributed by this Skill ZIP.

This is an independent compatibility component, not an official DS Bot or DeepSeek product.
