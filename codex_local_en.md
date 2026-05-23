# How to switch Codex to use domestic or local models

## Modify the config file
```bash
vi ~/.codex/config.toml
```

### Remove marketplace and default model config
```toml

[marketplaces.openai-bundled]

[marketplaces.openai-bundled]
last_updated = "2026-xxxx"
source_type = "local"
source = "/Users/xxxxxx"


[marketplaces.openai-primary-runtime]
last_updated = "2026-0xxx"
source_type = "local"
source = "/Users/xxxx"

# The gpt5 config at the end of the file

[tui.model_availability_nux]
"gpt-5.5" = 4

```

### 1. Then add your local config
```toml
# ===================== Stable DeepSeek config =====================
model = "deepseek-v4-pro"
model_provider = "local"
cli_auth_credentials_store = "file"
skip_git_repo_check = true
requires_openai_auth = false

[model_providers.local]
name = "local Proxy"
base_url = "http://127.0.0.1:19090/v1"
wire_api = "responses"
# DeepSeek API key
api_key = "sk-d74cbxxxxxxx4"
```

## Start the proxy service (this project)
```bash
npm start
 # Adjust proxy config if needed (usually not necessary)
```

### 2. Restart Codex
```bash
echo "sk_xxxx" | codex login --with-api-key
codex reset
```
