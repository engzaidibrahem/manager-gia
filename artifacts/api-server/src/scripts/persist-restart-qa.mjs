/**
 * HTTP persistence + graceful restart QA against gia-v3-test on PORT 5001.
 * Never touches production (5000).
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";

const BASE = "http://127.0.0.1:5001";
const ROOT = "d:/gia-shawarma-manager-self-host";
const TEST_DB = `${ROOT}/.data/gia-v3-test`;
const OUT = `${ROOT}/backups/gia-v3-persist-restart-qa.json`;

async function json(res) {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return { raw: t };
  }
}

async function main() {
  const hz = await (await fetch(`${BASE}/api/healthz`)).json();
  if (hz?.database?.kind !== "v3-test") {
    throw new Error(`REFUSE: not test DB: ${JSON.stringify(hz)}`);
  }

  const login = await (
    await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin123" }),
    })
  ).json();
  const h = { Authorization: `Bearer ${login.token}`, "content-type": "application/json" };

  const stamp = Date.now().toString(36);

  async function createPurchase(body) {
    const res = await fetch(`${BASE}/api/v3/purchases`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
    });
    const data = await json(res);
    if (!res.ok) throw new Error(`create failed ${res.status}: ${JSON.stringify(data)}`);
    return data;
  }

  const wh = await createPurchase({
    itemName: `persist-WH-${stamp}`,
    quantityNumeric: 13,
    quantityRaw: "13",
    unitRaw: "kg",
    totalAmount: 130000,
    paymentStatus: "UNPAID",
    destination: "WAREHOUSE",
    clientRequestId: `pr-wh-${stamp}`,
  });
  const kit = await createPurchase({
    itemName: `persist-KIT-${stamp}`,
    quantityNumeric: 6,
    quantityRaw: "6",
    unitRaw: "kg",
    totalAmount: 60000,
    paymentStatus: "UNPAID",
    destination: "KITCHEN_DIRECT",
    clientRequestId: `pr-kit-${stamp}`,
  });
  const cons = await createPurchase({
    itemName: `persist-CONS-${stamp}`,
    quantityNumeric: 1,
    quantityRaw: "1",
    totalAmount: 5000,
    paymentStatus: "UNPAID",
    destination: "CONSUMABLE",
    clientRequestId: `pr-cons-${stamp}`,
  });

  if (!wh.committed || !wh.purchaseId || !wh.movementId || !wh.inventoryItemId) {
    throw new Error(`WAREHOUSE missing commit proof: ${JSON.stringify(wh)}`);
  }
  if (!kit.committed || !kit.purchaseId || !kit.movementId || !kit.inventoryItemId) {
    throw new Error(`KITCHEN missing commit proof: ${JSON.stringify(kit)}`);
  }
  if (!cons.committed || !cons.purchaseId || cons.movementId != null) {
    throw new Error(`CONSUMABLE bad commit proof: ${JSON.stringify(cons)}`);
  }

  // Simulated backend failure — must not look like success
  const bad = await fetch(`${BASE}/api/v3/purchases`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ itemName: "x", totalAmount: 1, destination: "NOPE" }),
  });
  const badBody = await json(bad);
  if (bad.ok) throw new Error("expected validation failure");

  const ids = {
    whP: wh.purchaseId,
    whI: wh.inventoryItemId,
    whM: wh.movementId,
    kitP: kit.purchaseId,
    kitI: kit.inventoryItemId,
    kitM: kit.movementId,
    consP: cons.purchaseId,
  };

  // Find listen PID for 5001
  const net = spawn("cmd", ["/c", "netstat -ano"], { shell: false });
  let netOut = "";
  await new Promise((resolve) => {
    net.stdout.on("data", (d) => (netOut += d.toString()));
    net.on("close", resolve);
  });
  const line = netOut
    .split(/\r?\n/)
    .find((l) => l.includes(":5001") && l.includes("LISTENING"));
  const pid = Number((line || "").trim().split(/\s+/).pop());
  if (!Number.isFinite(pid) || pid <= 0) throw new Error("could not find 5001 PID");

  // Graceful SIGINT (not force-kill)
  process.kill(pid, "SIGINT");
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      await fetch(`${BASE}/api/healthz`, { signal: AbortSignal.timeout(500) });
    } catch {
      break;
    }
  }

  // Disk verify while API down
  const p = new PGlite(TEST_DB);
  const whRow = (
    await p.query(
      `SELECT id, destination, quantity_numeric::float8 AS qty, inventory_item_id, movement_id, status
       FROM v3_purchases WHERE id = $1`,
      [ids.whP],
    )
  ).rows[0];
  const kitRow = (
    await p.query(
      `SELECT id, destination, inventory_item_id, movement_id, status FROM v3_purchases WHERE id = $1`,
      [ids.kitP],
    )
  ).rows[0];
  const consRow = (
    await p.query(
      `SELECT id, destination, movement_id, status FROM v3_purchases WHERE id = $1`,
      [ids.consP],
    )
  ).rows[0];
  const wm = (
    await p.query(
      `SELECT id, movement_type, status FROM v3_warehouse_movements WHERE id = $1`,
      [ids.whM],
    )
  ).rows[0];
  const km = (
    await p.query(
      `SELECT id, movement_type, status FROM v3_warehouse_movements WHERE id = $1`,
      [ids.kitM],
    )
  ).rows[0];
  const wi = (
    await p.query(
      `SELECT id, warehouse_qty_numeric::float8 AS wh FROM v3_inventory_items WHERE id = $1`,
      [ids.whI],
    )
  ).rows[0];
  const ki = (
    await p.query(
      `SELECT id, kitchen_qty_numeric::float8 AS kit, warehouse_qty_numeric::float8 AS wh
       FROM v3_inventory_items WHERE id = $1`,
      [ids.kitI],
    )
  ).rows[0];
  await p.close();

  if (!whRow || !kitRow || !consRow || !wm || !km) {
    throw new Error(`disk missing rows after graceful stop: ${JSON.stringify({ whRow, kitRow, consRow, wm, km })}`);
  }

  // Restart API on test DB
  const child = spawn(
    "pnpm.cmd",
    ["--filter", "@workspace/api-server", "run", "start"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        V3_TEST_MODE: "true",
        NODE_ENV: "test",
        DATABASE_URL: `pglite://${TEST_DB}`,
        PORT: "5001",
        AUTH_SECRET: "gia-dev-secret",
      },
      stdio: "ignore",
      shell: true,
      detached: true,
      windowsHide: true,
    },
  );
  child.unref();

  let up = false;
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const hz2 = await (await fetch(`${BASE}/api/healthz`)).json();
      if (hz2?.database?.kind === "v3-test") {
        up = true;
        break;
      }
    } catch {
      /* */
    }
  }
  if (!up) throw new Error("test API did not restart");

  const login2 = await (
    await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin123" }),
    })
  ).json();
  const h2 = { Authorization: `Bearer ${login2.token}` };
  const purchases = await (await fetch(`${BASE}/api/v3/purchases?pageSize=100`, { headers: h2 })).json();
  const inbound = await (
    await fetch(`${BASE}/api/v3/warehouse/movements?type=WAREHOUSE_IN&pageSize=100`, { headers: h2 })
  ).json();
  const kitchen = await (await fetch(`${BASE}/api/v3/kitchen`, { headers: h2 })).json();

  const report = {
    ok: true,
    failureSimulated: { status: bad.status, body: badBody },
    ids,
    afterGracefulStopDisk: { whRow, kitRow, consRow, wm, km, wi, ki },
    afterRestartHttp: {
      purchasesTotal: purchases.total,
      hasWh: purchases.rows.some((r) => r.id === ids.whP),
      hasKit: purchases.rows.some((r) => r.id === ids.kitP),
      hasCons: purchases.rows.some((r) => r.id === ids.consP),
      inboundHas: inbound.rows.some((r) => r.id === ids.whM),
      kitchenHas: kitchen.rows.some((r) => r.id === ids.kitI),
    },
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));
  if (
    !report.afterRestartHttp.hasWh ||
    !report.afterRestartHttp.hasKit ||
    !report.afterRestartHttp.hasCons ||
    !report.afterRestartHttp.inboundHas ||
    !report.afterRestartHttp.kitchenHas
  ) {
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
