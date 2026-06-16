import { getDatabase } from '../database/connection';

export enum BizType {
  STOCK_IN = 'stock_in',
  REQUISITION = 'requisition',
  INVENTORY = 'inventory',
  EXPIRY_ALERT = 'expiry_alert',
  DISPOSAL = 'disposal',
  CABINET = 'cabinet',
  NOTIFICATION = 'notification'
}

export enum LogAction {
  CREATE = 'create',
  UPDATE = 'update',
  AUDIT = 'audit',
  APPROVE = 'approve',
  REJECT = 'reject',
  LOCK = 'lock',
  UNLOCK = 'unlock',
  CONSUME = 'consume',
  RETURN = 'return',
  INVENTORY_CHECK = 'inventory_check',
  SCRAP = 'scrap',
  ALERT = 'alert',
  DISPOSAL = 'disposal',
  READ = 'read',
  ALLOCATE = 'allocate',
  COMPLETE = 'complete'
}

export interface LogRecord {
  bizType: BizType | string;
  action: LogAction | string;
  title: string;
  detail?: string;
  relatedType?: string;
  relatedId?: number;
  operatorId?: number;
  operatorName?: string;
  operatorRole?: string;
  oldValue?: any;
  newValue?: any;
  status?: string;
}

export function logOperation(record: LogRecord): number {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO operation_logs (
      biz_type, action, title, detail,
      related_type, related_id,
      operator_id, operator_name, operator_role,
      old_value, new_value, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    record.bizType,
    record.action,
    record.title,
    record.detail || null,
    record.relatedType || null,
    record.relatedId || null,
    record.operatorId || null,
    record.operatorName || null,
    record.operatorRole || null,
    record.oldValue !== undefined ? JSON.stringify(record.oldValue) : null,
    record.newValue !== undefined ? JSON.stringify(record.newValue) : null,
    record.status || null
  );

  return Number(result.lastInsertRowid);
}

export interface LogQueryParams {
  bizType?: BizType | string;
  action?: LogAction | string;
  relatedType?: string;
  relatedId?: number;
  operatorId?: number;
  operatorRole?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  pageSize?: number;
}

export function queryOperationLogs(params: LogQueryParams): { list: any[]; total: number } {
  const db = getDatabase();
  const conditions: string[] = [];
  const values: any[] = [];

  if (params.bizType) {
    conditions.push('biz_type = ?');
    values.push(params.bizType);
  }
  if (params.action) {
    conditions.push('action = ?');
    values.push(params.action);
  }
  if (params.relatedType) {
    conditions.push('related_type = ?');
    values.push(params.relatedType);
  }
  if (params.relatedId !== undefined) {
    conditions.push('related_id = ?');
    values.push(params.relatedId);
  }
  if (params.operatorId !== undefined) {
    conditions.push('operator_id = ?');
    values.push(params.operatorId);
  }
  if (params.operatorRole) {
    conditions.push('operator_role LIKE ?');
    values.push(`%${params.operatorRole}%`);
  }
  if (params.startDate) {
    conditions.push('created_at >= ?');
    values.push(params.startDate);
  }
  if (params.endDate) {
    conditions.push('created_at <= ?');
    values.push(params.endDate + ' 23:59:59');
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const totalStmt = db.prepare(`SELECT COUNT(*) as total FROM operation_logs ${whereClause}`);
  const { total } = totalStmt.get(...values) as { total: number };

  const page = params.page || 1;
  const pageSize = params.pageSize || 20;
  const offset = (page - 1) * pageSize;

  const listStmt = db.prepare(`
    SELECT * FROM operation_logs
    ${whereClause}
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `);

  const list = listStmt.all(...values, pageSize, offset) as any[];

  return { list, total };
}

export function getOperationLog(id: number): any | null {
  const db = getDatabase();
  const log = db.prepare('SELECT * FROM operation_logs WHERE id = ?').get(id) as any;
  if (!log) return null;

  if (log.old_value) {
    try { log.old_value = JSON.parse(log.old_value); } catch (_) {}
  }
  if (log.new_value) {
    try { log.new_value = JSON.parse(log.new_value); } catch (_) {}
  }

  return log;
}
