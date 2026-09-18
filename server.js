const http = require("http");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3021);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "data", "db.json");

// 复测签核状态机：
// pending（待签核）-> approved（已通过）/ rejected（已驳回）
// pending 在出现新的调校后 -> invalidated（已失效，历史仍可检索）
const SIGNOFF = {
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  INVALIDATED: "invalidated"
};

const SIGNOFF_LABELS = {
  pending: "待签核",
  approved: "已通过",
  rejected: "已驳回",
  invalidated: "已失效"
};

const now = () => new Date().toISOString();

const initialData = {
  clocks: [
    {
      id: "clock_demo",
      code: "CLK-1890-07",
      escapementType: "瑞士杠杆式",
      balanceFrequency: "18000vph",
      targetDailyRateSeconds: 20,
      note: "怀表机芯，走时偏快",
      createdAt: now()
    }
  ],
  adjustments: [
    {
      id: "adjustment_demo",
      clockId: "clock_demo",
      currentDailyRateSeconds: 68,
      direction: "慢针方向",
      amount: "游丝快慢针向慢侧微调0.4格",
      note: "初次调校，先保守处理",
      createdAt: now()
    }
  ],
  retests: [
    {
      id: "retest_demo",
      clockId: "clock_demo",
      adjustmentId: "adjustment_demo",
      testedBy: "周慎之",
      testedAt: now(),
      createdAt: now(),
      dailyRateSeconds: 31,
      amplitude: 248,
      qualified: false,
      note: "仍偏快，振幅尚可",
      signoffStatus: SIGNOFF.APPROVED,
      signoff: {
        conclusion: SIGNOFF.APPROVED,
        signature: "衡鉴工",
        signedAt: now(),
        note: "确认首轮结论，继续调校"
      }
    }
  ]
};

const routes = [
  "GET /health",
  "GET /clocks",
  "POST /clocks",
  "GET /clocks/not-qualified",
  "GET /clocks/:id/history",
  "POST /clocks/:id/adjustments",
  "POST /clocks/:id/retests",
  "POST /clocks/:id/retests/:retestId/signoff",
  "GET /clocks/:id/latest-retest",
  "GET /adjustments",
  "GET /retests?clockId=&qualified=&signoffStatus="
];

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

// 旧数据迁移：没有签核字段的复测视为历史上已签核通过，结论继续有效
function migrate(db) {
  let changed = false;
  for (const retest of db.retests || []) {
    if (!retest.signoffStatus) {
      retest.signoffStatus = SIGNOFF.APPROVED;
      changed = true;
    }
    if (!("signoff" in retest)) {
      retest.signoff = null;
      changed = true;
    }
    if (!("testedBy" in retest)) {
      retest.testedBy = "";
      changed = true;
    }
    if (!retest.createdAt && retest.testedAt) {
      retest.createdAt = retest.testedAt;
      changed = true;
    }
  }
  return changed;
}

async function readDb() {
  await ensureDb();
  const db = JSON.parse(await readFile(DB_FILE, "utf8"));
  if (migrate(db)) await writeDb(db);
  return db;
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, "请求体必须是合法JSON");
  }
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) throw httpError(400, `缺少字段：${missing.join(", ")}`);
}

function findClock(db, clockId) {
  const clock = db.clocks.find((item) => item.id === clockId);
  if (!clock) throw httpError(404, "钟表不存在");
  return clock;
}

function recordTime(record) {
  return record.createdAt || record.testedAt || "";
}

// 同一时刻写入时，后写入的记录视为更新
function newestOf(records) {
  return records.reduce((latest, item) =>
    !latest || new Date(recordTime(item)) >= new Date(recordTime(latest)) ? item : latest, null);
}

function latestRetest(db, clockId) {
  return newestOf(db.retests.filter((item) => item.clockId === clockId));
}

// 合格状态只认已签核通过的复测
function latestApprovedRetest(db, clockId) {
  return newestOf(
    db.retests.filter((item) => item.clockId === clockId && item.signoffStatus === SIGNOFF.APPROVED)
  );
}

function latestAdjustment(db, clockId) {
  return newestOf(db.adjustments.filter((item) => item.clockId === clockId));
}

function effectiveQualified(db, clockId) {
  const approved = latestApprovedRetest(db, clockId);
  return approved ? Boolean(approved.qualified) : false;
}

function clockSummary(db, clock) {
  const retest = latestRetest(db, clock.id);
  return {
    ...clock,
    latestAdjustment: latestAdjustment(db, clock.id),
    latestRetest: retest,
    retestSignoffStatus: retest ? retest.signoffStatus : null,
    qualified: effectiveQualified(db, clock.id)
  };
}

function normalizeConclusion(value) {
  const v = String(value).trim().toLowerCase();
  if (v === SIGNOFF.APPROVED || v === "通过" || v === "合格") return SIGNOFF.APPROVED;
  if (v === SIGNOFF.REJECTED || v === "驳回" || v === "不合格") return SIGNOFF.REJECTED;
  throw httpError(400, "结论必须是 approved（通过）或 rejected（驳回）");
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "clock-escapement-tuning-api", routes });
  }

  if (req.method === "GET" && pathname === "/clocks") {
    const qualified = url.searchParams.get("qualified");
    let data = db.clocks.map((clock) => clockSummary(db, clock));
    if (qualified !== null) {
      const expected = qualified === "true";
      data = data.filter((clock) => clock.qualified === expected);
    }
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/clocks") {
    const body = await parseBody(req);
    required(body, ["code", "escapementType", "balanceFrequency"]);
    const clock = {
      id: makeId("clock"),
      code: body.code,
      escapementType: body.escapementType,
      balanceFrequency: body.balanceFrequency,
      targetDailyRateSeconds: Number(body.targetDailyRateSeconds ?? 30),
      note: body.note || "",
      createdAt: now()
    };
    db.clocks.push(clock);
    await writeDb(db);
    return send(res, 201, { data: clockSummary(db, clock) });
  }

  if (req.method === "GET" && pathname === "/clocks/not-qualified") {
    const data = db.clocks.map((clock) => clockSummary(db, clock)).filter((clock) => !clock.qualified);
    return send(res, 200, { data });
  }

  const historyMatch = pathname.match(/^\/clocks\/([^/]+)\/history$/);
  if (historyMatch && req.method === "GET") {
    const clock = findClock(db, historyMatch[1]);
    const adjustments = db.adjustments.filter((item) => item.clockId === clock.id);
    const retests = db.retests.filter((item) => item.clockId === clock.id);
    return send(res, 200, {
      data: {
        clock,
        adjustments,
        retests,
        latestRetest: latestRetest(db, clock.id),
        qualified: effectiveQualified(db, clock.id)
      }
    });
  }

  const adjustmentMatch = pathname.match(/^\/clocks\/([^/]+)\/adjustments$/);
  if (adjustmentMatch && req.method === "POST") {
    const clock = findClock(db, adjustmentMatch[1]);
    const body = await parseBody(req);
    required(body, ["currentDailyRateSeconds", "direction", "amount"]);
    const adjustment = {
      id: makeId("adjustment"),
      clockId: clock.id,
      currentDailyRateSeconds: Number(body.currentDailyRateSeconds),
      direction: body.direction,
      amount: body.amount,
      note: body.note || "",
      createdAt: now()
    };
    db.adjustments.push(adjustment);
    // 新的调校使所有待签核复测失效，记录保留可检索
    const invalidatedAt = adjustment.createdAt;
    for (const retest of db.retests) {
      if (retest.clockId === clock.id && retest.signoffStatus === SIGNOFF.PENDING) {
        retest.signoffStatus = SIGNOFF.INVALIDATED;
        retest.invalidatedAt = invalidatedAt;
        retest.invalidatedByAdjustmentId = adjustment.id;
      }
    }
    await writeDb(db);
    return send(res, 201, { data: adjustment, clock: clockSummary(db, clock) });
  }

  const retestMatch = pathname.match(/^\/clocks\/([^/]+)\/retests$/);
  if (retestMatch && req.method === "POST") {
    const clock = findClock(db, retestMatch[1]);
    const body = await parseBody(req);
    required(body, ["dailyRateSeconds", "amplitude", "testedBy"]);
    const testedBy = String(body.testedBy).trim();
    if (!testedBy) throw httpError(400, "缺少字段：testedBy");

    // 复测必须针对一条调校记录
    let adjustment;
    if (body.adjustmentId) {
      adjustment = db.adjustments.find(
        (item) => item.id === body.adjustmentId && item.clockId === clock.id
      );
      if (!adjustment) throw httpError(400, "指定的调校记录不存在");
    } else {
      adjustment = latestAdjustment(db, clock.id);
    }
    if (!adjustment) throw httpError(400, "尚无调校记录，请先创建调校后再复测");

    const latest = latestRetest(db, clock.id);
    if (latest && latest.signoffStatus === SIGNOFF.PENDING) {
      throw httpError(409, "已有待签核的复测记录，请先完成签核或创建新的调校");
    }
    if (latest && latest.signoffStatus === SIGNOFF.REJECTED) {
      const hasNewAdjustment = db.adjustments.some(
        (item) =>
          item.clockId === clock.id &&
          new Date(item.createdAt) > new Date(recordTime(latest))
      );
      if (!hasNewAdjustment) {
        throw httpError(409, "上一条复测已被驳回，必须先创建新的调校记录才能再次复测");
      }
    }

    const qualified = body.qualified !== undefined
      ? Boolean(body.qualified)
      : Math.abs(Number(body.dailyRateSeconds)) <= Number(clock.targetDailyRateSeconds);
    const testedAt = body.testedAt || now();
    const retest = {
      id: makeId("retest"),
      clockId: clock.id,
      adjustmentId: adjustment.id,
      testedBy,
      testedAt,
      createdAt: now(),
      dailyRateSeconds: Number(body.dailyRateSeconds),
      amplitude: Number(body.amplitude),
      qualified,
      note: body.note || "",
      signoffStatus: SIGNOFF.PENDING,
      signoff: null
    };
    db.retests.push(retest);
    await writeDb(db);
    // 待签核复测不改变钟表合格状态
    return send(res, 201, { data: retest, clock: clockSummary(db, clock) });
  }

  const signoffMatch = pathname.match(/^\/clocks\/([^/]+)\/retests\/([^/]+)\/signoff$/);
  if (signoffMatch && req.method === "POST") {
    const clock = findClock(db, signoffMatch[1]);
    const retest = db.retests.find(
      (item) => item.id === signoffMatch[2] && item.clockId === clock.id
    );
    if (!retest) throw httpError(404, "复测记录不存在");

    // 重复签核 / 已失效记录签核一律 409，且不得写入
    if (retest.signoffStatus !== SIGNOFF.PENDING) {
      throw httpError(
        409,
        `复测记录当前为「${SIGNOFF_LABELS[retest.signoffStatus] || retest.signoffStatus}」状态，不能重复签核`
      );
    }

    const body = await parseBody(req);
    required(body, ["conclusion", "signature"]);
    const conclusion = normalizeConclusion(body.conclusion);
    const signature = String(body.signature).trim();
    if (!signature) throw httpError(400, "缺少字段：signature");

    // 签核人不得与复测记录人相同
    if (retest.testedBy && signature === String(retest.testedBy).trim()) {
      throw httpError(409, "签核人不得与复测记录人为同一人");
    }

    retest.signoffStatus = conclusion;
    retest.signoff = {
      conclusion,
      signature,
      signedAt: now(),
      note: body.note || ""
    };
    await writeDb(db);
    // 只有签核通过，复测结论才生效
    return send(res, 200, { data: retest, clock: clockSummary(db, clock) });
  }

  const latestMatch = pathname.match(/^\/clocks\/([^/]+)\/latest-retest$/);
  if (latestMatch && req.method === "GET") {
    const clockId = latestMatch[1];
    findClock(db, clockId);
    return send(res, 200, {
      data: latestRetest(db, clockId),
      qualified: effectiveQualified(db, clockId)
    });
  }

  if (req.method === "GET" && pathname === "/adjustments") {
    const clockId = url.searchParams.get("clockId");
    return send(res, 200, { data: db.adjustments.filter((item) => !clockId || item.clockId === clockId) });
  }

  if (req.method === "GET" && pathname === "/retests") {
    const clockId = url.searchParams.get("clockId");
    const qualified = url.searchParams.get("qualified");
    const signoffStatus = url.searchParams.get("signoffStatus");
    const data = db.retests.filter((item) => {
      if (clockId && item.clockId !== clockId) return false;
      if (signoffStatus !== null && item.signoffStatus !== signoffStatus) return false;
      // 合格筛选只统计已签核通过的复测
      if (qualified !== null) {
        if (item.signoffStatus !== SIGNOFF.APPROVED) return false;
        if (item.qualified !== (qualified === "true")) return false;
      }
      return true;
    });
    return send(res, 200, { data });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Clock escapement tuning API running at http://127.0.0.1:${PORT}`);
});
