# 机械钟表擒纵调校API

纯后端零依赖Node服务，使用 `data/db.json` 持久化钟表档案、调校记录和复测记录。

## 启动

```bash
PORT=3021 node server.js
```

## 主要接口

- `GET /health`
- `GET /clocks`
- `POST /clocks`
- `GET /clocks/not-qualified`
- `GET /clocks/:id/history`
- `POST /clocks/:id/adjustments`
- `POST /clocks/:id/retests`
- `POST /retests/:id/signoff`
- `GET /clocks/:id/latest-retest`
- `GET /adjustments?clockId=`
- `GET /retests?clockId=&qualified=&status=`

## 复测签核流程

复测记录有 `status` 状态：`pending`（待签核）→ `approved`（通过）/ `rejected`（驳回），
或被新调校置为 `voided`（失效，历史仍可检索）。

- `POST /clocks/:id/retests` 必须带 `recordedBy`（复测记录人）。写入后停在 `pending`，
  **不影响**钟表合格状态；合格状态只由最新一条 `approved` 复测决定。
- `POST /retests/:id/signoff` 签核，必填：
  - `decision`：`approved` 或 `rejected`
  - `conclusion`：签核结论
  - `signedBy`：签核人签名
- 签核人不得与复测记录人相同，否则返回 409 且不写入。
- 只能签核 `pending` 记录；重复签核或签核已失效记录返回 409 且不写入。
- 签核通过后，该复测的合格结论才生效。
- 驳回后必须先录入新的调校，才能再次复测，否则返回 409。
- 新调校会让该钟表所有 `pending` 复测记录失效（`voided`），记录仍保留可检索。
- `GET /clocks`、`GET /clocks/:id/history`、`GET /clocks/:id/latest-retest`
  返回的复测状态与合格状态保持一致。

## 闭环示例

```bash
curl http://127.0.0.1:3021/clocks/not-qualified

# 录入复测（待签核）
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/retests \
  -H 'Content-Type: application/json' \
  -d '{"dailyRateSeconds":12,"amplitude":252,"recordedBy":"张三","note":"复测进入目标范围"}'

# 另一人签核通过，合格状态生效
curl -X POST http://127.0.0.1:3021/retests/<retestId>/signoff \
  -H 'Content-Type: application/json' \
  -d '{"decision":"approved","conclusion":"走时达标，同意放行","signedBy":"李四"}'
```
