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

export function getUnreadNotifications(roles: string[]): any[] {
  const db = getDatabase();
  const placeholders = roles.map(() => '?').join(',');

  const stmt = db.prepare(`
    SELECT * FROM notifications
    WHERE read_status = 'unread'
    AND (
      ${roles.map(role => `recipient_roles LIKE '%' || ? || '%'`).join(' OR ')}
    )
    ORDER BY created_at DESC
    LIMIT 100
  `);

  return stmt.all(...roles, ...roles);
}

export function markNotificationAsRead(id: number): boolean {
  const db = getDatabase();
  const stmt = db.prepare(`
    UPDATE notifications SET read_status = 'read' WHERE id = ?
  `);
  const result = stmt.run(id);
  return result.changes > 0;
}

export function handleAlert(id: number): boolean {
  const db = getDatabase();
  const stmt = db.prepare(`
    UPDATE alerts SET status = 'handled', handled_at = datetime('now', 'localtime') WHERE id = ?
  `);
  const result = stmt.run(id);
  return result.changes > 0;
}
