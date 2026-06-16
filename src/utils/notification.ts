import { getDatabase } from '../database/connection';
import { AlertType } from '../types';

export interface NotificationPayload {
  type: string;
  title: string;
  content: string;
  relatedType?: string;
  relatedId?: number;
  recipientRoles: string[];
}

const DEFAULT_ROLES = ['warehouse_manager', 'operating_room_nurse'];

export function sendNotification(payload: NotificationPayload): number {
  const db = getDatabase();

  const roles = payload.recipientRoles.length > 0 ? payload.recipientRoles : DEFAULT_ROLES;

  const stmt = db.prepare(`
    INSERT INTO notifications (type, title, content, related_type, related_id, recipient_roles)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    payload.type,
    payload.title,
    payload.content,
    payload.relatedType || null,
    payload.relatedId || null,
    roles.join(',')
  );

  console.log(`[通知推送] 类型: ${payload.type} | 标题: ${payload.title} | 接收角色: ${roles.join(', ')}`);

  return Number(result.lastInsertRowid);
}

export function createAlert(
  type: AlertType,
  title: string,
  content: string,
  relatedType?: string,
  relatedId?: number,
  notifiedRoles: string[] = DEFAULT_ROLES
): number {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO alerts (type, title, content, related_type, related_id, notified_roles)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    type,
    title,
    content,
    relatedType || null,
    relatedId || null,
    notifiedRoles.join(',')
  );

  sendNotification({
    type,
    title,
    content,
    relatedType,
    relatedId,
    recipientRoles: notifiedRoles
  });

  console.log(`[预警创建] 类型: ${type} | 标题: ${title}`);

  return Number(result.lastInsertRowid);
}

export interface NotificationQueryParams {
  roles?: string[];
  type?: string;
  relatedType?: string;
  readStatus?: 'unread' | 'read' | 'all';
  startDate?: string;
  endDate?: string;
  page?: number;
  pageSize?: number;
}

export function getNotifications(params: NotificationQueryParams = {}): { list: any[]; total: number; unreadTotal: number } {
  const db = getDatabase();

  const effectiveRoles = params.roles && params.roles.length > 0
    ? params.roles
    : DEFAULT_ROLES;

  const conditions: string[] = [];
  const values: any[] = [];

  const roleConditions = effectiveRoles.map(() => `recipient_roles LIKE ?`).join(' OR ');
  conditions.push(`(${roleConditions})`);
  effectiveRoles.forEach(role => values.push(`%${role}%`));

  if (params.type) {
    conditions.push('type = ?');
    values.push(params.type);
  }
  if (params.relatedType) {
    conditions.push('related_type = ?');
    values.push(params.relatedType);
  }
  const readStatus = params.readStatus || 'unread';
  if (readStatus !== 'all') {
    conditions.push('read_status = ?');
    values.push(readStatus);
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

  const unreadStmt = db.prepare(`
    SELECT COUNT(*) as total FROM notifications
    WHERE read_status = 'unread' AND (${roleConditions})
  `);
  const unreadResult = unreadStmt.get(...effectiveRoles.map(r => `%${r}%`)) as { total: number };

  const totalStmt = db.prepare(`SELECT COUNT(*) as total FROM notifications ${whereClause}`);
  const { total } = totalStmt.get(...values) as { total: number };

  const page = params.page || 1;
  const pageSize = params.pageSize || 20;
  const offset = (page - 1) * pageSize;

  const listStmt = db.prepare(`
    SELECT * FROM notifications
    ${whereClause}
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `);

  const list = listStmt.all(...values, pageSize, offset) as any[];

  return { list, total, unreadTotal: unreadResult.total };
}

export function getUnreadNotifications(roles?: string[]): any[] {
  const result = getNotifications({ roles, readStatus: 'unread', pageSize: 100 });
  return result.list;
}

export function markNotificationAsRead(id: number): boolean {
  const db = getDatabase();
  const stmt = db.prepare(`
    UPDATE notifications SET read_status = 'read' WHERE id = ? AND read_status = 'unread'
  `);
  const result = stmt.run(id);
  return result.changes > 0;
}

export function batchMarkNotificationsRead(ids: number[], roles?: string[]): { success: number; failed: number } {
  const db = getDatabase();
  if (!ids || ids.length === 0) return { success: 0, failed: 0 };

  const placeholders = ids.map(() => '?').join(',');
  const stmt = db.prepare(`
    UPDATE notifications
    SET read_status = 'read'
    WHERE id IN (${placeholders}) AND read_status = 'unread'
  `);

  const result = stmt.run(...ids);
  return {
    success: result.changes,
    failed: ids.length - result.changes
  };
}

export function markAllNotificationsRead(roles?: string[]): number {
  const db = getDatabase();

  const effectiveRoles = roles && roles.length > 0 ? roles : DEFAULT_ROLES;
  const roleConditions = effectiveRoles.map(() => `recipient_roles LIKE ?`).join(' OR ');
  const params = effectiveRoles.map(role => `%${role}%`);

  const stmt = db.prepare(`
    UPDATE notifications SET read_status = 'read'
    WHERE read_status = 'unread' AND (${roleConditions})
  `);

  const result = stmt.run(...params);
  return result.changes;
}

export function getNotificationTypes(): { type: string; count: number }[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT type, COUNT(*) as count
    FROM notifications
    GROUP BY type
    ORDER BY count DESC
  `).all() as { type: string; count: number }[];
}

export function handleAlert(id: number): boolean {
  const db = getDatabase();
  const stmt = db.prepare(`
    UPDATE alerts SET status = 'handled', handled_at = datetime('now', 'localtime') WHERE id = ?
  `);
  const result = stmt.run(id);
  return result.changes > 0;
}
