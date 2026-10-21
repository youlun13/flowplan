# flowplan-ai（Cloudflare Worker）

保管 Anthropic API key 的小型代理。瀏覽器只持有通關密語，永遠拿不到 key。

- `POST /v1/ai`：`{ op: "parse_incident" | "explain_plan", ... }`，需 `Authorization: Bearer <FLOWPLAN_PROXY_SECRET>`
- `GET /v1/health`：確認設定與金鑰是否存在（同樣需要通關密語）

環境變數：`ANTHROPIC_API_KEY`（Secret）、`FLOWPLAN_PROXY_SECRET`（Secret）、`ALLOWED_ORIGINS`、`AI_MODEL`、`AI_MAX_OUTPUT_TOKENS`。

防護：通關密語、Origin allowlist、模型 allowlist、輸出 token 上限、請求大小上限、25 秒逾時。
真正的費用硬上限請在 Anthropic Console 的 workspace 設 spend limit；這個 Worker 不是帳單的保證。
