import { Router, type IRouter } from "express";
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  attendanceTable,
  dailyPurchasesTable,
  employeesTable,
  expensesTable,
  incomeTable,
  inventoryItemsTable,
  inventoryMovementsTable,
  recipeLinesTable,
  wasteRecordsTable,
} from "@workspace/db";
import {
  CreateAttendanceBody,
  CreateAttendanceResponse,
  CreateEmployeeBody,
  CreateEmployeeResponse,
  CreateExpenseBody,
  CreateExpenseResponse,
  CreateIncomeBody,
  CreateIncomeResponse,
  CreateInventoryItemBody,
  CreateInventoryItemResponse,
  CreateInventoryMovementBody,
  CreateInventoryMovementResponse,
  DeleteAttendanceParams,
  DeleteEmployeeParams,
  DeleteExpenseParams,
  DeleteIncomeParams,
  DeleteInventoryItemParams,
  GetDashboardSummaryQueryParams,
  GetDashboardSummaryResponse,
  ListAttendanceQueryParams,
  ListAttendanceResponse,
  ListEmployeesResponse,
  ListExpensesQueryParams,
  ListExpensesResponse,
  ListIncomeQueryParams,
  ListIncomeResponse,
  ListInventoryItemsQueryParams,
  ListInventoryItemsResponse,
  ListInventoryMovementsQueryParams,
  ListInventoryMovementsResponse,
  UpdateAttendanceBody,
  UpdateAttendanceParams,
  UpdateAttendanceResponse,
  UpdateEmployeeBody,
  UpdateEmployeeParams,
  UpdateEmployeeResponse,
  UpdateExpenseBody,
  UpdateExpenseParams,
  UpdateExpenseResponse,
  UpdateIncomeBody,
  UpdateIncomeParams,
  UpdateIncomeResponse,
  UpdateInventoryItemBody,
  UpdateInventoryItemParams,
  UpdateInventoryItemResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

const iso = (value: Date) => value.toISOString();

const serializeItem = (item: typeof inventoryItemsTable.$inferSelect) => ({
  ...item,
  brand: item.brand ?? "",
  variant: item.variant ?? "",
  qrToken: item.qrToken || "",
  updatedAt: iso(item.updatedAt),
});

const serializeMovement = (
  row: typeof inventoryMovementsTable.$inferSelect & { itemName: string; unit: string },
) => ({
  id: row.id,
  itemId: row.itemId,
  itemName: row.itemName,
  type: row.type as "in" | "out" | "kitchen" | "adjustment" | "transfer",
  quantity: row.quantity,
  unit: row.unit,
  note: row.note,
  actor: row.actor,
  location: row.location,
  createdAt: iso(row.createdAt),
});

const serializeExpense = (row: typeof expensesTable.$inferSelect) => ({
  ...row,
  createdAt: iso(row.createdAt),
});

const serializeIncome = (row: typeof incomeTable.$inferSelect) => ({
  ...row,
  createdAt: iso(row.createdAt),
});

router.get("/dashboard/summary", async (req, res): Promise<void> => {
  const parsed = GetDashboardSummaryQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const date = parsed.data.date ?? new Date().toISOString().slice(0, 10);
  const [incomeResult, expenseResult, purchaseResult, lowStockResult, kitchenResult, attendanceResult, wasteResult] =
    await Promise.all([
      db.select({ total: sql<number>`coalesce(sum(${incomeTable.amount}), 0)` }).from(incomeTable).where(eq(incomeTable.incomeDate, date)),
      db.select({ total: sql<number>`coalesce(sum(${expensesTable.amount}), 0)` }).from(expensesTable).where(eq(expensesTable.expenseDate, date)),
      db.select({ total: sql<number>`coalesce(sum(${dailyPurchasesTable.totalAmount}), 0)`, count: sql<number>`count(*)` }).from(dailyPurchasesTable).where(eq(dailyPurchasesTable.purchaseDate, date)),
      db.select({ count: sql<number>`count(*)` }).from(inventoryItemsTable).where(sql`${inventoryItemsTable.currentStock} <= ${inventoryItemsTable.minimumStock}`),
      db.select({ count: sql<number>`count(*)` }).from(inventoryMovementsTable).where(and(eq(inventoryMovementsTable.type, "kitchen"), sql`${inventoryMovementsTable.createdAt}::date = ${date}`)),
      db.select({ count: sql<number>`count(*)` }).from(attendanceTable).where(eq(attendanceTable.attendanceDate, date)),
      db.select({ total: sql<number>`coalesce(sum(${wasteRecordsTable.costEstimate}), 0)` }).from(wasteRecordsTable).where(eq(wasteRecordsTable.wasteDate, date)),
    ]);

  const [recentExpenses, recentIncome, recentMovements, recentPurchases] = await Promise.all([
    db.select().from(expensesTable).where(eq(expensesTable.expenseDate, date)).orderBy(desc(expensesTable.createdAt)).limit(3),
    db.select().from(incomeTable).where(eq(incomeTable.incomeDate, date)).orderBy(desc(incomeTable.createdAt)).limit(3),
    db.select({ movement: inventoryMovementsTable, itemName: inventoryItemsTable.name }).from(inventoryMovementsTable)
      .innerJoin(inventoryItemsTable, eq(inventoryMovementsTable.itemId, inventoryItemsTable.id))
      .where(sql`${inventoryMovementsTable.createdAt}::date = ${date}`)
      .orderBy(desc(inventoryMovementsTable.createdAt)).limit(3),
    db.select().from(dailyPurchasesTable).where(eq(dailyPurchasesTable.purchaseDate, date)).orderBy(desc(dailyPurchasesTable.createdAt)).limit(3),
  ]);

  const activities = [
    ...recentExpenses.map((row) => ({
      id: `expense-${row.id}`,
      kind: "expense",
      title: "مصروف مسجل",
      detail: `${row.description} • ${Number(row.amount).toLocaleString("id-ID")} IDR`,
      createdAt: iso(row.createdAt),
    })),
    ...recentIncome.map((row) => ({
      id: `income-${row.id}`,
      kind: "income",
      title: "وارد مسجل",
      detail: `${row.source} • ${Number(row.amount).toLocaleString("id-ID")} IDR`,
      createdAt: iso(row.createdAt),
    })),
    ...recentMovements.map(({ movement, itemName }) => ({
      id: `movement-${movement.id}`,
      kind: movement.type,
      title: movement.type === "kitchen" ? "إخراج للمطبخ" : "حركة مستودع",
      detail: `${itemName} • ${movement.quantity} ${movement.type}`,
      createdAt: iso(movement.createdAt),
    })),
    ...recentPurchases.map((row) => ({
      id: `purchase-${row.id}`,
      kind: "purchase",
      title: "مشتريات اليوم",
      detail: `${row.itemName} · ${row.supplier} • ${Number(row.totalAmount).toLocaleString("id-ID")} IDR`,
      createdAt: iso(row.createdAt),
    })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8);

  res.json({
    date,
    totalIncome: Number(incomeResult[0]?.total ?? 0),
    totalExpenses: Number(expenseResult[0]?.total ?? 0),
    netCash: Number(incomeResult[0]?.total ?? 0) - Number(expenseResult[0]?.total ?? 0),
    lowStockCount: Number(lowStockResult[0]?.count ?? 0),
    kitchenMovements: Number(kitchenResult[0]?.count ?? 0),
    attendanceCount: Number(attendanceResult[0]?.count ?? 0),
    totalPurchases: Number(purchaseResult[0]?.total ?? 0),
    purchaseCount: Number(purchaseResult[0]?.count ?? 0),
    wasteCost: Number(wasteResult[0]?.total ?? 0),
    recentActivity: activities,
  });
});

router.get("/inventory/items", async (req, res): Promise<void> => {
  const parsed = ListInventoryItemsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const filters = [];
  if (parsed.data.search) {
    filters.push(or(ilike(inventoryItemsTable.name, `%${parsed.data.search}%`), ilike(inventoryItemsTable.category, `%${parsed.data.search}%`)));
  }
  if (parsed.data.lowStockOnly) {
    filters.push(sql`${inventoryItemsTable.currentStock} <= ${inventoryItemsTable.minimumStock}`);
  }
  const items = await db.select().from(inventoryItemsTable)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(inventoryItemsTable.category), asc(inventoryItemsTable.name));
  res.json(items.map(serializeItem));
});

router.post("/inventory/items", async (req, res): Promise<void> => {
  const parsed = CreateInventoryItemBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [item] = await db.insert(inventoryItemsTable).values({
    ...parsed.data,
    kitchenStock: (parsed.data as { kitchenStock?: number }).kitchenStock ?? 0,
    costPerUnit: parsed.data.costPerUnit ?? 0,
    qrToken: `gia-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
  }).returning();
  res.status(201).json(serializeItem(item));
});

router.patch("/inventory/items/:id", async (req, res): Promise<void> => {
  const params = UpdateInventoryItemParams.safeParse(req.params);
  const parsed = UpdateInventoryItemBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [item] = await db.update(inventoryItemsTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(inventoryItemsTable.id, params.data.id))
    .returning();
  if (!item) {
    res.status(404).json({ error: "Inventory item not found" });
    return;
  }
  res.json(serializeItem(item));
});

router.delete("/inventory/items/:id", async (req, res): Promise<void> => {
  const params = DeleteInventoryItemParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const item = await db.query.inventoryItemsTable.findFirst({ where: eq(inventoryItemsTable.id, params.data.id) });
  if (!item) {
    res.status(404).json({ error: "Inventory item not found" });
    return;
  }
  await db.transaction(async (tx) => {
    await tx.delete(recipeLinesTable).where(eq(recipeLinesTable.inventoryItemId, params.data.id));
    await tx.delete(wasteRecordsTable).where(eq(wasteRecordsTable.inventoryItemId, params.data.id));
    await tx.delete(inventoryMovementsTable).where(eq(inventoryMovementsTable.itemId, params.data.id));
    await tx.delete(inventoryItemsTable).where(eq(inventoryItemsTable.id, params.data.id));
  });
  res.status(204).send();
});

router.get("/inventory/movements", async (req, res): Promise<void> => {
  const parsed = ListInventoryMovementsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const filters = [];
  if (parsed.data.date) filters.push(sql`${inventoryMovementsTable.createdAt}::date = ${parsed.data.date}`);
  if (parsed.data.type) filters.push(eq(inventoryMovementsTable.type, parsed.data.type));
  const rows = await db.select({ movement: inventoryMovementsTable, itemName: inventoryItemsTable.name, unit: inventoryItemsTable.unit })
    .from(inventoryMovementsTable)
    .innerJoin(inventoryItemsTable, eq(inventoryMovementsTable.itemId, inventoryItemsTable.id))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(inventoryMovementsTable.createdAt))
    .limit(parsed.data.limit ?? 50);
  res.json(ListInventoryMovementsResponse.parse(rows.map((row) => serializeMovement({ ...row.movement, itemName: row.itemName, unit: row.unit }))));
});

router.post("/inventory/movements", async (req, res): Promise<void> => {
  const parsed = CreateInventoryMovementBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const item = await db.query.inventoryItemsTable.findFirst({ where: eq(inventoryItemsTable.id, parsed.data.itemId) });
  if (!item) {
    res.status(404).json({ error: "Inventory item not found" });
    return;
  }
  const isKitchen = parsed.data.type === "kitchen";
  const location = isKitchen ? "kitchen" : "warehouse";
  const delta = parsed.data.type === "in" || parsed.data.type === "adjustment" ? parsed.data.quantity : -parsed.data.quantity;
  const stockField = isKitchen ? item.kitchenStock : item.currentStock;
  if (stockField + delta < 0) {
    res.status(400).json({ error: isKitchen ? "Kitchen stock would go negative" : "Warehouse stock would go negative" });
    return;
  }
  try {
    const movement = await db.transaction(async (tx) => {
      const [created] = await tx.insert(inventoryMovementsTable).values({
        ...parsed.data,
        location,
      }).returning();
      await tx.update(inventoryItemsTable).set({
        ...(isKitchen
          ? { kitchenStock: item.kitchenStock + delta }
          : { currentStock: item.currentStock + delta }),
        updatedAt: new Date(),
      }).where(eq(inventoryItemsTable.id, item.id));
      return created;
    });
    res.status(201).json(serializeMovement({
      ...movement,
      itemName: item.name,
      unit: item.unit,
    }));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Movement failed" });
  }
});

router.get("/finance/expenses", async (req, res): Promise<void> => {
  const parsed = ListExpensesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const rows = await db.select().from(expensesTable)
    .where(parsed.data.date ? eq(expensesTable.expenseDate, parsed.data.date) : undefined)
    .orderBy(desc(expensesTable.expenseDate), desc(expensesTable.createdAt))
    .limit(parsed.data.limit ?? 50);
  res.json(ListExpensesResponse.parse(rows.map(serializeExpense)));
});

router.post("/finance/expenses", async (req, res): Promise<void> => {
  const parsed = CreateExpenseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db.insert(expensesTable).values({
    ...parsed.data,
    expenseTime: parsed.data.expenseTime ?? "",
  }).returning();
  res.status(201).json(CreateExpenseResponse.parse(serializeExpense(row)));
});

router.patch("/finance/expenses/:id", async (req, res): Promise<void> => {
  const params = UpdateExpenseParams.safeParse(req.params);
  const parsed = UpdateExpenseBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db.update(expensesTable)
    .set(parsed.data)
    .where(eq(expensesTable.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Expense not found" });
    return;
  }
  res.json(UpdateExpenseResponse.parse(serializeExpense(row)));
});

router.delete("/finance/expenses/:id", async (req, res): Promise<void> => {
  const params = DeleteExpenseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db.delete(expensesTable).where(eq(expensesTable.id, params.data.id)).returning();
  if (!row) {
    res.status(404).json({ error: "Expense not found" });
    return;
  }
  res.status(204).send();
});

router.get("/finance/income", async (req, res): Promise<void> => {
  const parsed = ListIncomeQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const rows = await db.select().from(incomeTable)
    .where(parsed.data.date ? eq(incomeTable.incomeDate, parsed.data.date) : undefined)
    .orderBy(desc(incomeTable.incomeDate), desc(incomeTable.createdAt))
    .limit(parsed.data.limit ?? 50);
  res.json(ListIncomeResponse.parse(rows.map(serializeIncome)));
});

router.post("/finance/income", async (req, res): Promise<void> => {
  const parsed = CreateIncomeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db.insert(incomeTable).values({
    ...parsed.data,
    incomeTime: parsed.data.incomeTime ?? "",
  }).returning();
  res.status(201).json(CreateIncomeResponse.parse(serializeIncome(row)));
});

router.patch("/finance/income/:id", async (req, res): Promise<void> => {
  const params = UpdateIncomeParams.safeParse(req.params);
  const parsed = UpdateIncomeBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db.update(incomeTable)
    .set(parsed.data)
    .where(eq(incomeTable.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Income not found" });
    return;
  }
  res.json(UpdateIncomeResponse.parse(serializeIncome(row)));
});

router.delete("/finance/income/:id", async (req, res): Promise<void> => {
  const params = DeleteIncomeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db.delete(incomeTable).where(eq(incomeTable.id, params.data.id)).returning();
  if (!row) {
    res.status(404).json({ error: "Income not found" });
    return;
  }
  res.status(204).send();
});

router.get("/staff/employees", async (_req, res): Promise<void> => {
  const rows = await db.select().from(employeesTable).orderBy(asc(employeesTable.fullName));
  res.json(ListEmployeesResponse.parse(rows));
});

router.post("/staff/employees", async (req, res): Promise<void> => {
  const parsed = CreateEmployeeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db.insert(employeesTable).values({
    ...parsed.data,
    phone: parsed.data.phone ?? "",
    status: parsed.data.status ?? "active",
  }).returning();
  res.status(201).json(CreateEmployeeResponse.parse(row));
});

router.patch("/staff/employees/:id", async (req, res): Promise<void> => {
  const params = UpdateEmployeeParams.safeParse(req.params);
  const parsed = UpdateEmployeeBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db.update(employeesTable)
    .set(parsed.data)
    .where(eq(employeesTable.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Employee not found" });
    return;
  }
  res.json(UpdateEmployeeResponse.parse(row));
});

router.delete("/staff/employees/:id", async (req, res): Promise<void> => {
  const params = DeleteEmployeeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const employee = await db.query.employeesTable.findFirst({ where: eq(employeesTable.id, params.data.id) });
  if (!employee) {
    res.status(404).json({ error: "Employee not found" });
    return;
  }
  await db.transaction(async (tx) => {
    await tx.delete(attendanceTable).where(eq(attendanceTable.employeeId, params.data.id));
    await tx.delete(employeesTable).where(eq(employeesTable.id, params.data.id));
  });
  res.status(204).send();
});

router.get("/staff/attendance", async (req, res): Promise<void> => {
  const parsed = ListAttendanceQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const filters = [];
  if (parsed.data.date) filters.push(eq(attendanceTable.attendanceDate, parsed.data.date));
  if (parsed.data.employeeId) filters.push(eq(attendanceTable.employeeId, parsed.data.employeeId));
  const rows = await db.select({ attendance: attendanceTable, employeeName: employeesTable.fullName })
    .from(attendanceTable)
    .innerJoin(employeesTable, eq(attendanceTable.employeeId, employeesTable.id))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(attendanceTable.attendanceDate), asc(employeesTable.fullName));
  res.json(ListAttendanceResponse.parse(rows.map(({ attendance, employeeName }) => ({ ...attendance, employeeName }))));
});

router.post("/staff/attendance", async (req, res): Promise<void> => {
  const parsed = CreateAttendanceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const employee = await db.query.employeesTable.findFirst({ where: eq(employeesTable.id, parsed.data.employeeId) });
  if (!employee) {
    res.status(404).json({ error: "Employee not found" });
    return;
  }
  const [row] = await db.insert(attendanceTable).values(parsed.data).returning();
  res.status(201).json(CreateAttendanceResponse.parse({ ...row, employeeName: employee.fullName }));
});

router.patch("/staff/attendance/:id", async (req, res): Promise<void> => {
  const params = UpdateAttendanceParams.safeParse(req.params);
  const parsed = UpdateAttendanceBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (parsed.data.employeeId) {
    const employee = await db.query.employeesTable.findFirst({ where: eq(employeesTable.id, parsed.data.employeeId) });
    if (!employee) {
      res.status(404).json({ error: "Employee not found" });
      return;
    }
  }
  const [row] = await db.update(attendanceTable)
    .set(parsed.data)
    .where(eq(attendanceTable.id, params.data.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Attendance not found" });
    return;
  }
  const employee = await db.query.employeesTable.findFirst({ where: eq(employeesTable.id, row.employeeId) });
  res.json(UpdateAttendanceResponse.parse({ ...row, employeeName: employee?.fullName ?? "" }));
});

router.delete("/staff/attendance/:id", async (req, res): Promise<void> => {
  const params = DeleteAttendanceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db.delete(attendanceTable).where(eq(attendanceTable.id, params.data.id)).returning();
  if (!row) {
    res.status(404).json({ error: "Attendance not found" });
    return;
  }
  res.status(204).send();
});

export default router;