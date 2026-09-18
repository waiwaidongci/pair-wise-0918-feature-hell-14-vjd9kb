# 机械钟表擒纵调校API

纯后端零依赖Node服务，使用 `data/db.json` 持久化钟表档案、调校记录和复测记录。

## 启动

```bash
PORT=3021 node server.js
```

测试时可用 `DB_FILE=/tmp/test-db.json node server.js` 指向独立数据库文件。

## 主要接口

- `GET /health`
- `GET /clocks`（支持 `?qualified=true|false`）
- `POST /clocks`
- `GET /clocks/not-qualified`
- `GET /clocks/:id/history`
- `POST /clocks/:id/adjustments`
- `POST /clocks/:id/retests`
- `POST /clocks/:id/retests/:retestId/signoff`
- `GET /clocks/:id/latest-retest`
- `GET /adjustments?clockId=`
- `GET /retests?clockId=&qualified=&signoffStatus=`

## 复测签核流程

复测写入后**先停在待签核（`pending`）**，此时钟表合格状态不变；必须由他人签核后结论才生效。

复测状态机：

- `pending`（待签核）→ `approved`（已通过）/ `rejected`（已驳回）
- 待签核期间创建新的调校 → 复测变为 `invalidated`（已失效，历史仍可检索）

规则：

1. `POST /retests` 必填 `dailyRateSeconds`、`amplitude`、`testedBy`（复测记录人），新建记录状态恒为 `pending`。
2. `POST /retests/:id/signoff` 必填 `conclusion`（`approved`/`rejected`，也接受 `通过`/`驳回`）和 `signature`（签名）。
3. 签核人不得与复测记录人相同；同人签核或对已签核/已失效记录重复签核返回 **409**，且不写入。
4. 签核**通过**后，复测的 `qualified` 结论才生效，钟表列表、单表历史、最新复测接口的 `qualified` 始终一致（只取最新一条已通过复测）。
5. 签核**驳回**后，必须先 `POST /adjustments` 创建新的调校，才能再次复测，否则返回 **409**。
6. 新的调校会让该钟表所有待签核复测失效；已失效记录仍可通过历史与复测列表检索。
7. 已存在待签核复测时不能再提交复测（**409**）。

## 闭环示例

```bash
# 1. 新调校（同时会令旧的待签核复测失效）
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/adjustments \
  -H 'Content-Type: application/json' \
  -d '{"currentDailyRateSeconds":31,"direction":"慢针方向","amount":"快慢针再向慢侧微调0.3格"}'

# 2. 复测（停在待签核，钟表仍为不合格）
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/retests \
  -H 'Content-Type: application/json' \
  -d '{"dailyRateSeconds":12,"amplitude":252,"testedBy":"周慎之","note":"复测进入目标范围"}'

# 3. 他人签核通过（签名不能与 testedBy 相同）
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/retests/<retestId>/signoff \
  -H 'Content-Type: application/json' \
  -d '{"conclusion":"approved","signature":"衡鉴工"}'

# 状态核对：三处结果一致
curl http://127.0.0.1:3021/clocks
curl http://127.0.0.1:3021/clocks/clock_demo/history
curl http://127.0.0.1:3021/clocks/clock_demo/latest-retest
```
