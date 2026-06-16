import { getDatabase } from '../database/connection';
import { AlertType, AlertStatus } from '../types';
import { daysUntilExpiry } from '../utils/date';
import { createAlert, sendNotification } from '../utils/notification';
import { generateDisposalNo } from '../utils/trace-code';
import { logOperation, BizType, LogAction } from './operation-log.service';

export interface ExpiryCheckResult {
  alertsCreated: number;
  itemsLocked: number;
  itemsScrapped: number;
  details: {
    alert30: any[];
    alert7: any[];
    expired: any[];
  };
}

export function checkAndHandleExpiry(): ExpiryCheckResult {
  const db = getDatabase();
  const result: ExpiryCheckResult = {
    alertsCreated: 0,
    itemsLocked: 0,
    itemsScrapped: 0,
    details: { alert30: [], alert7: [], expired: [] }
  };

  const tx = db.transaction(() => {
    const expiringItems = db.prepare(`
      SELECT i.*,
             c.name as consumable_name, c.code as consumable_code,
             sc.code as cabinet_code, sc.name as cabinet_name,
             cs.slot_code,
             s.name as supplier_name
      FROM inventory i
      LEFT JOIN consumables c ON i.consumable_id = c.id
      LEFT JOIN smart_cabinets sc ON i.cabinet_id = sc.id
      LEFT JOIN cabinet_slots cs ON i.slot_id = cs.id
      LEFT JOIN suppliers s ON i.supplier_id = s.id
      WHERE i.quantity > 0
      AND i.status != 'expired'
      AND i.status != 'scrapped'
    `).all() as any[];

    for (const item of expiringItems) {
      const daysLeft = daysUntilExpiry(item.expiry_date);

      if (daysLeft < 0) {
        const existingAlert = db.prepare(`
          SELECT id FROM alerts
          WHERE related_type = 'inventory' AND related_id = ? AND type = ?
        `).get(item.id, AlertType.EXPIRED);

        if (!existingAlert) {
          const alertId = createAlert(
            AlertType.EXPIRED,
            '耗材已过期，自动报废',
            `【${item.consumable_name}】批次${item.batch_no}已过期${-daysLeft}天，追溯码${item.trace_code}，数量${item.quantity}，已自动报废`,
            'inventory',
            item.id
          );

          const disposalNo = generateDisposalNo();
          db.prepare(`
            INSERT INTO disposal_records (
              disposal_no, consumable_id, batch_no, quantity, reason,
              trace_codes, handler_id, handler_name, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
          `).run(
            disposalNo,
            item.consumable_id,
            item.batch_no,
            item.quantity,
            `过期自动报废（超过有效期${-daysLeft}天）`,
            item.trace_code,
            0,
            '系统自动'
          );

          db.prepare(`
            UPDATE inventory
            SET status = 'scrapped',
                updated_at = datetime('now', 'localtime')
            WHERE id = ?
          `).run(item.id);

          db.prepare(`
            UPDATE cabinet_slots
            SET quantity = MAX(0, quantity - ?),
                status = CASE WHEN MAX(0, quantity - ?) = 0 THEN 'empty' ELSE status END,
                consumable_id = CASE WHEN MAX(0, quantity - ?) = 0 THEN NULL ELSE consumable_id END,
                batch_no = CASE WHEN MAX(0, quantity - ?) = 0 THEN NULL ELSE batch_no END
            WHERE id = ?
          `).run(item.quantity, item.quantity, item.quantity, item.quantity, item.slot_id);

          result.details.expired.push(item);
          result.itemsScrapped++;
          result.alertsCreated++;
        }
      } else if (daysLeft <= 7) {
        const existingAlert = db.prepare(`
          SELECT id FROM alerts
          WHERE related_type = 'inventory' AND related_id = ? AND type = ?
        `).get(item.id, AlertType.EXPIRY_7);

        let alreadyLocked = item.status === 'near_expiry_locked';

        if (!existingAlert || !alreadyLocked) {
          if (!existingAlert) {
            createAlert(
              AlertType.EXPIRY_7,
              `耗材7天内过期预警（${daysLeft}天）`,
              `【${item.consumable_name}】批次${item.batch_no}将在${daysLeft}天后过期（${item.expiry_date}），追溯码${item.trace_code}，数量${item.quantity}，已锁定出库禁止领用`,
              'inventory',
              item.id
            );
          }

          if (!alreadyLocked) {
            db.prepare(`
              UPDATE inventory
              SET status = 'near_expiry_locked',
                  updated_at = datetime('now', 'localtime')
              WHERE id = ?
            `).run(item.id);

            db.prepare(`
              UPDATE cabinet_slots SET locked = 1 WHERE id = ?
            `).run(item.slot_id);

            result.itemsLocked++;
          }

          result.details.alert7.push(item);
          if (!existingAlert) result.alertsCreated++;
        }
      } else if (daysLeft <= 30) {
        const existingAlert = db.prepare(`
          SELECT id FROM alerts
          WHERE related_type = 'inventory' AND related_id = ? AND type = ?
        `).get(item.id, AlertType.EXPIRY_30);

        let alreadyLocked = item.status === 'near_expiry_locked';

        if (!existingAlert || !alreadyLocked) {
          if (!existingAlert) {
            createAlert(
              AlertType.EXPIRY_30,
              `耗材30天内过期预警（${daysLeft}天）`,
              `【${item.consumable_name}】批次${item.batch_no}将在${daysLeft}天后过期（${item.expiry_date}），追溯码${item.trace_code}，数量${item.quantity}，已锁定出库禁止领用`,
              'inventory',
              item.id
            );
          }

          if (!alreadyLocked) {
            db.prepare(`
              UPDATE inventory
              SET status = 'near_expiry_locked',
                  updated_at = datetime('now', 'localtime')
              WHERE id = ?
            `).run(item.id);

            db.prepare(`
              UPDATE cabinet_slots SET locked = 1 WHERE id = ?
            `).run(item.slot_id);

            result.itemsLocked++;
          }

          result.details.alert30.push(item);
          if (!existingAlert) result.alertsCreated++;
        }
      }
    }
  });

  tx();

  return result;
}

export function manualDispose(
  inventoryIds: number[],
  reason: string,
  handlerId: number,
  handlerName?: string
): { success: boolean; message: string; data?: any } {
  const db = getDatabase();

  if (inventoryIds.length === 0) {
    return { success: false, message: '请选择要报废的库存' };
  }

  const tx = db.transaction(() => {
    const disposalNo = generateDisposalNo();
    const items: any[] = [];

    for (const invId of inventoryIds) {
      const item = db.prepare('SELECT * FROM inventory WHERE id = ?').get(invId) as any;
      if (!item) continue;
      if (item.status === 'scrapped' || item.quantity <= 0) continue;

      items.push(item);

      db.prepare(`
        UPDATE inventory
        SET status = 'scrapped',
            updated_at = datetime('now', 'localtime')
        WHERE id = ?
      `).run(invId);

      db.prepare(`
        UPDATE cabinet_slots
        SET quantity = MAX(0, quantity - ?),
            status = CASE WHEN MAX(0, quantity - ?) = 0 THEN 'empty' ELSE status END,
            consumable_id = CASE WHEN MAX(0, quantity - ?) = 0 THEN NULL ELSE consumable_id END,
            batch_no = CASE WHEN MAX(0, quantity - ?) = 0 THEN NULL ELSE batch_no END
        WHERE id = ?
      `).run(item.quantity, item.quantity, item.quantity, item.quantity, item.slot_id);
    }

    if (items.length === 0) {
      throw new Error('没有可报废的库存');
    }

    const firstItem = items[0];
    const traceCodes = items.map(i => i.trace_code).join(',');
    const totalQty = items.reduce((sum, i) => sum + i.quantity, 0);

    db.prepare(`
      INSERT INTO disposal_records (
        disposal_no, consumable_id, batch_no, quantity, reason,
        trace_codes, handler_id, handler_name, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
    `).run(
      disposalNo,
      firstItem.consumable_id,
      firstItem.batch_no,
      totalQty,
      reason,
      traceCodes,
      handlerId,
      handlerName || null
    );

    return { disposalNo, itemsCount: items.length, totalQty };
  });

  try {
    const data = tx();

    sendNotification({
      type: 'manual_disposal',
      title: '耗材人工报废',
      content: `${data.itemsCount}项耗材（共${data.totalQty}个）已人工报废，原因：${reason}，处置单号：${data.disposalNo}`,
      relatedType: 'disposal',
      recipientRoles: ['warehouse_manager', 'operating_room_nurse']
    });

    logOperation({
      bizType: BizType.DISPOSAL,
      action: LogAction.SCRAP,
      title: '人工报废耗材',
      detail: `${data.itemsCount}项共${data.totalQty}个，原因：${reason}，处置单号：${data.disposalNo}`,
      relatedType: 'disposal',
      operatorId: handlerId,
      operatorName: handlerName,
      operatorRole: 'warehouse_manager',
      status: 'scrapped'
    });

    return {
      success: true,
      message: `已报废${data.itemsCount}项共${data.totalQty}个耗材`,
      data
    };
  } catch (err: any) {
    return { success: false, message: err.message };
  }
}

export function getActiveAlerts(params: {
  type?: AlertType; status?: AlertStatus; page?: number; pageSize?: number
} = {}): { list: any[]; total: number } {
  const db = getDatabase();
  const conditions: string[] = [];
  const values: any[] = [];

  if (params.type) {
    conditions.push('a.type = ?');
    values.push(params.type);
  }
  if (params.status) {
    conditions.push('a.status = ?');
    values.push(params.status);
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const countStmt = db.prepare(`SELECT COUNT(*) as total FROM alerts a ${whereClause}`);
  const { total } = countStmt.get(...values) as { total: number };

  const page = params.page || 1;
  const pageSize = params.pageSize || 20;
  const offset = (page - 1) * pageSize;

  const listStmt = db.prepare(`
    SELECT a.* FROM alerts a
    ${whereClause}
    ORDER BY a.created_at DESC
    LIMIT ? OFFSET ?
  `);

  const list = listStmt.all(...values, pageSize, offset) as any[];

  return { list, total };
}

export function getDisposalList(params: {
  startDate?: string; endDate?: string; consumableId?: number; page?: number; pageSize?: number
} = {}): { list: any[]; total: number } {
  const db = getDatabase();
  const conditions: string[] = [];
  const values: any[] = [];

  if (params.startDate) {
    conditions.push('d.created_at >= ?');
    values.push(params.startDate);
  }
  if (params.endDate) {
    conditions.push('d.created_at <= ?');
    values.push(params.endDate + ' 23:59:59');
  }
  if (params.consumableId) {
    conditions.push('d.consumable_id = ?');
    values.push(params.consumableId);
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const countStmt = db.prepare(`SELECT COUNT(*) as total FROM disposal_records d ${whereClause}`);
  const { total } = countStmt.get(...values) as { total: number };

  const page = params.page || 1;
  const pageSize = params.pageSize || 20;
  const offset = (page - 1) * pageSize;

  const listStmt = db.prepare(`
    SELECT d.*,
           c.name as consumable_name, c.code as consumable_code, c.unit
    FROM disposal_records d
    LEFT JOIN consumables c ON d.consumable_id = c.id
    ${whereClause}
    ORDER BY d.created_at DESC
    LIMIT ? OFFSET ?
  `);

  const list = listStmt.all(...values, pageSize, offset) as any[];

  return { list, total };
}
