# 如何把codex内置的模型改为国内或者本地的

## 修改配置文件
vi ~/.codex/config.toml

### 删除marketplace和默认模型的配置
```text

[marketplaces.openai-bundled]

[marketplaces.openai-bundled]
last_updated = "2026-xxxx"
source_type = "local"
source = "/Users/xxxxxx"


[marketplaces.openai-primary-runtime]
last_updated = "2026-0xxx"
source_type = "local"
source = "/Users/xxxx"

# 文件最后的gpt5配置

[tui.model_availability_nux]
"gpt-5.5" = 4

```

### 1. 然后添加本地的配置
```text
# ===================== 稳定可用的 DeepSeek 配置 =====================
model = "deepseek-v4-pro"
model_provider = "local"
cli_auth_credentials_store = "file"
skip_git_repo_check = true
requires_openai_auth = false

[model_providers.local]
name = "local Proxy"
base_url = "http://127.0.0.1:19090/v1"
wire_api = "responses"
# deepseek的sk配置
api_key = "sk-d74cbxxxxxxx4"
```

## 启动代理服务（本项目）
```bash 
npm start
 # 调整代理配置（正常不用配置）
```

### 2. 重启codex
```bash
codex reset
```
