export type AppErrorCode =
  | "INSUFFICIENT_STOCK"
  | "INVALID_UNIT"
  | "INVALID_UNIT_CONVERSION"
  | "ITEM_NOT_FOUND"
  | "ITEM_ARCHIVED"
  | "LOT_NOT_FOUND"
  | "PURCHASE_NOT_FOUND"
  | "PURCHASE_ALREADY_RECEIVED"
  | "PURCHASE_CANCELLED"
  | "PURCHASE_HAS_RECEIVING"
  | "RECEIVE_EXCEEDS_REMAINING"
  | "TRANSFER_FAILED"
  | "MOVEMENT_NOT_FOUND"
  | "EMPLOYEE_NOT_FOUND"
  | "PAYROLL_NOT_FOUND"
  | "UNAUTHORIZED_OPERATION"
  | "VALIDATION_ERROR"
  | "WASTE_IMMUTABLE"
  | "CONFLICT";

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: AppErrorCode, message: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function toErrorResponse(error: unknown): { status: number; body: { error: string; code?: string; details?: Record<string, unknown> } } {
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: { error: error.message, code: error.code, details: error.details },
    };
  }
  const message = error instanceof Error ? error.message : "Request failed";
  if (/insufficient/i.test(message)) {
    return { status: 400, body: { error: message, code: "INSUFFICIENT_STOCK" } };
  }
  if (/incompatible units|cannot convert/i.test(message)) {
    return { status: 400, body: { error: message, code: "INVALID_UNIT_CONVERSION" } };
  }
  if (/forbidden|permission|unauthorized/i.test(message)) {
    return { status: 403, body: { error: "You do not have permission to perform this operation.", code: "UNAUTHORIZED_OPERATION" } };
  }
  // Hide raw DB / driver internals from clients
  if (/postgres|pglite|drizzle|ECONNREFUSED|syntax error/i.test(message)) {
    return { status: 500, body: { error: "A database error occurred. Please try again or contact support." } };
  }
  return { status: 400, body: { error: message } };
}
