import { getDatabase } from '../database/connection';
import { ConsumptionStatus, RequisitionStatus } from '../types';
import { consumeInventory } from './cabinet.service';
import { sendNotification } from '../utils/notification';
import { daysUntilExpiry } from '../utils/date';

export interface ConsumptionCreateRequest {
  requisitionId?: number;
  traceCode: string;
  consumableId: number;
  cabinetId: number;
  slotId: number;
  quantityUsed: number;
  patientId?: string;
  surgeryId?: string;
  operatorId: number;
  operatorName?: string;
}

export function recordConsumption(request: ConsumptionCreateRequest): {
  success: boolean;
  message: string;
  data?: any;
} {
  const db = getDatabase();

  const inventory = db.prepare(`
    SELECT i.*, c.name as consumable_name, c.unit
    FROM inventory i
    LEFT JOIN consumables c ON i.consumable_id = c.id
    WHERE i.trace_code = ?
  `).get(request.traceCode) as any;

  if (!inventory) {
    return { success: false, message: '追溯码对应的库存不存在' };
  }

  if (inventory.status === 'near_expiry_locked') {
    const daysLeft = daysUntilExpiry(inventory.expiry_date);
    return {
      success: false,
      message: `[临期锁定] 该批次耗材已因临近效期锁定出库（剩余${daysLeft}天，有效期至${inventory.expiry_date}），请更换批次使用`,
      data: {
        blockedReason: 'near_expiry',
        daysLeft,
        expiryDate: inventory.expiry_date,
        traceCode: inventory.trace_code
      }
    };
  }

  if (inventory.status === 'scrapped') {
    return {
      success: false,
      message: '[已报废] 该批次耗材已被报废，无法出库',
      data: { blockedReason: 'scrapped', traceCode: inventory.trace_code }
    };
  }

  if (inventory.status !== 'normal') {
    return {
      success: false,
      message: `[状态异常] 库存状态为 ${inventory.status}，无法出库`,
      data: { blockedReason: inventory.status, traceCode: inventory.trace_code }
    };
  }

  if (request.quantityUsed > inventory.quantity) {
    return {
      success: false,
      message: `使用量超过库存，当前库存：${inventory.quantity}${inventory.unit}`
    };
  }

  const operator = request.operatorName || (db.prepare('SELECT name FROM users WHERE id = ?').get(request.operatorId) as any)?.name;

  const tx = db.transaction(() => {
    const consumeResult = consumeInventory(request.traceCode, request.quantityUsed, request.requisitionId);

    if (!consumeResult.success) {
      throw new Error(consumeResult.message || '库存扣减失败');
    }

    const stmt = db.prepare(`
      INSERT INTO consumption_records (
        requisition_id, trace_code, consumable_id, cabinet_id, slot_id,
        quantity_used, quantity_remaining, patient_id, surgery_id,
        operator_id, operator_name, status, used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
    `);

    const result = stmt.run(
      request.requisitionId || null,
      request.traceCode,
      request.consumableId,
      request.cabinetId,
      request.slotId,
      request.quantityUsed,
      consumeResult.remaining,
      request.patientId || null,
      request.surgeryId || null,
      request.operatorId,
      operator || null,
      consumeResult.remaining === 0 ? ConsumptionStatus.USED : ConsumptionStatus.PARTIAL,
    );

    return { id: Number(result.lastInsertRowid), remaining: consumeResult.remaining };
  });

  try {
    const result = tx();

    if (request.requisitionId) {
      const req = db.prepare('SELECT * FROM requisitions WHERE id = ?').get(request.requisitionId) as any;
      if (req) {
        const totalUsed = db.prepare(`
          SELECT SUM(quantity_used) as total FROM consumption_records WHERE requisition_id = ?
        `).get(request.requisitionId) as { total: number | null };

        if ((totalUsed.total || 0) >= req.requested_quantity) {
          db.prepare(`
            UPDATE requisitions
            SET status = ?, updated_at = datetime('now', 'localtime')
            WHERE id = ?
          `).run(RequisitionStatus.COMPLETED, request.requisitionId);

          sendNotification({
            type: 'requisition_completed',
            title: '领用单已完成',
            content: `领用申请【${req.requisition_no}】${inventory.consumable_name}已全部消耗完成`,
            relatedType: 'requisition',
            relatedId: request.requisitionId,
            recipientRoles: ['warehouse_manager', 'operating_room_nurse']
          });
        }
      }
    }

    sendNotification({
      type: 'consumption_recorded',
      title: '耗材使用记录已登记',
      content: `${inventory.consumable_name} x ${request.quantityUsed}${inventory.unit}已登记使用，追溯码：${request.traceCode}，剩余库存：${result.remaining}`,
      relatedType: 'consumption',
      relatedId: result.id,
      recipientRoles: ['warehouse_manager', 'operating_room_nurse']
    });

    return {
      success: true,
      message: '消耗记录已登记，库存已更新',
      data: {
        id: result.id,
        trace_code: request.traceCode,
        quantity_used: request.quantityUsed,
        quantity_remaining: result.remaining,
        consumable_name: inventory.consumable_name
      }
    };
  } catch (err: any) {
    return { success: false, message: err.message };
  }
}

export function autoInventoryByCabinet(cabinetId: number): {
  success: boolean;
  message: string;
  data?: {
    cabinetId: number;
    cabinetCode: string;
    totalItems: number;
    matchedItems: number;
    discrepantItems: any[];
  };
} {
  const db = getDatabase();

  const cabinet = db.prepare('SELECT * FROM smart_cabinets WHERE id = ?').get(cabinetId) as any;
  if (!cabinet) return { success: false, message: '智能柜不存在' };

  const slots = db.prepare(`
    SELECT cs.*, i.trace_code, i.quantity as inventory_qty, i.consumable_id, i.batch_no
    FROM cabinet_slots cs
    LEFT JOIN inventory i ON cs.id = i.slot_id AND i.status IN ('normal', 'partial')
    WHERE cs.cabinet_id = ?
    ORDER BY cs.layer, cs.position
  `).all(cabinetId) as any[];

  const discrepantItems: any[] = [];
  let matchedCount = 0;

  for (const slot of slots) {
    if (slot.status === 'occupied') {
      const expectedConsumable = slot.consumable_id;
      const expectedBatch = slot.batch_no;
      const expectedQty = slot.quantity;

      const actualInv = db.prepare(`
        SELECT SUM(quantity) as total FROM inventory
        WHERE slot_id = ? AND status != 'depleted'
      `).get(slot.id) as { total: number | null };

      const actualQty = actualInv.total || 0;

      if (expectedQty !== actualQty) {
        discrepantItems.push({
          slot_id: slot.id,
          slot_code: slot.slot_code,
          expected_consumable_id: expectedConsumable,
          expected_batch_no: expectedBatch,
          expected_quantity: expectedQty,
          actual_quantity: actualQty,
          discrepancy: actualQty - expectedQty
        });
      } else {
        matchedCount++;
      }
    }
  }

  const totalItems = slots.filter(s => s.status === 'occupied').length;

  db.prepare(`
    UPDATE cabinet_slots
    SET locked = 0
    WHERE cabinet_id = ? AND locked = 0
  `).run(cabinetId);

  if (discrepantItems.length > 0) {
    sendNotification({
      type: 'inventory_discrepancy',
      title: '智能柜盘点差异预警',
      content: `智能柜【${cabinet.code} ${cabinet.name}】盘点发现${discrepantItems.length}项差异，请核实处理`,
      relatedType: 'cabinet',
      relatedId: cabinetId,
      recipientRoles: ['warehouse_manager', 'operating_room_nurse']
    });
  }

  return {
    success: true,
    message: discrepantItems.length > 0
      ? `盘点完成，发现${discrepantItems.length}项差异`
      : `盘点完成，所有${totalItems}项账实一致`,
    data: {
      cabinetId,
      cabinetCode: cabinet.code,
      totalItems,
      matchedItems: matchedCount,
      discrepantItems
    }
  };
}

export function returnUnusedConsumables(
  traceCode: string,
  returnQuantity: number,
  operatorId: number,
  operatorName?: string
): { success: boolean; message: string } {
  const db = getDatabase();

  if (returnQuantity <= 0) {
    return { success: false, message: '退还数量必须大于0' };
  }

  const inventory = db.prepare('SELECT * FROM inventory WHERE trace_code = ?').get(traceCode) as any;
  if (!inventory) return { success: false, message: '追溯码不存在' };

  const operator = operatorName || (db.prepare('SELECT name FROM users WHERE id = ?').get(operatorId) as any)?.name;

  db.prepare(`
    INSERT INTO consumption_records (
      trace_code, consumable_id, cabinet_id, slot_id,
      quantity_used, quantity_remaining,
      operator_id, operator_name, status, used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
  `).run(
    traceCode,
    inventory.consumable_id,
    inventory.cabinet_id,
    inventory.slot_id,
    -returnQuantity,
    (inventory.quantity || 0) + returnQuantity,
    operatorId,
    operator || null,
    ConsumptionStatus.RETURNED
  );

  db.prepare(`
    UPDATE inventory
    SET quantity = quantity + ?,
        locked_quantity = MAX(0, locked_quantity - ?),
        updated_at = datetime('now', 'localtime')
    WHERE trace_code = ?
  `).run(returnQuantity, returnQuantity, traceCode);

  db.prepare(`
    UPDATE cabinet_slots
    SET quantity = quantity + ?
    WHERE id = ?
  `).run(returnQuantity, inventory.slot_id);

  return { success: true, message: `${returnQuantity}个耗材已退还，库存已更新` };
}

export function getConsumptionList(params: {
  startDate?: string; endDate?: string; consumableId?: number;
  cabinetId?: number; requisitionId?: number; page?: number; pageSize?: number
} = {}): { list: any[]; total: number } {
  const db = getDatabase();
  const conditions: string[] = [];
  const values: any[] = [];

  if (params.startDate) {
    conditions.push('cr.used_at >= ?');
    values.push(params.startDate);
  }
  if (params.endDate) {
    conditions.push('cr.used_at <= ?');
    values.push(params.endDate + ' 23:59:59');
  }
  if (params.consumableId) {
    conditions.push('cr.consumable_id = ?');
    values.push(params.consumableId);
  }
  if (params.cabinetId) {
    conditions.push('cr.cabinet_id = ?');
    values.push(params.cabinetId);
  }
  if (params.requisitionId) {
    conditions.push('cr.requisition_id = ?');
    values.push(params.requisitionId);
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const countStmt = db.prepare(`SELECT COUNT(*) as total FROM consumption_records cr ${whereClause}`);
  const { total } = countStmt.get(...values) as { total: number };

  const page = params.page || 1;
  const pageSize = params.pageSize || 20;
  const offset = (page - 1) * pageSize;

  const listStmt = db.prepare(`
    SELECT cr.*,
           c.name as consumable_name, c.code as consumable_code, c.category, c.unit,
           sc.code as cabinet_code, sc.name as cabinet_name,
           cs.slot_code, cs.layer, cs.position,
           r.requisition_no, r.patient_name
    FROM consumption_records cr
    LEFT JOIN consumables c ON cr.consumable_id = c.id
    LEFT JOIN smart_cabinets sc ON cr.cabinet_id = sc.id
    LEFT JOIN cabinet_slots cs ON cr.slot_id = cs.id
    LEFT JOIN requisitions r ON cr.requisition_id = r.id
    ${whereClause}
    ORDER BY cr.used_at DESC
    LIMIT ? OFFSET ?
  `);

  const list = listStmt.all(...values, pageSize, offset) as any[];

  return { list, total };
}
