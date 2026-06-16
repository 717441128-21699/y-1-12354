import { getDatabase } from '../database/connection';
import { StorageRequirement, CabinetStatus } from '../types';
import { daysUntilExpiry } from '../utils/date';

export interface CabinetAllocation {
  cabinet_id: number;
  cabinet_code: string;
  cabinet_name: string;
  slot_id: number;
  slot_code: string;
  layer: number;
  position: number;
}

export function allocateCabinetSlot(
  consumableId: number,
  storageRequirement: StorageRequirement,
  batchNo: string,
  preferredZone?: string
): CabinetAllocation | null {
  const db = getDatabase();

  let cabinets = db.prepare(`
    SELECT c.* FROM smart_cabinets c
    WHERE c.status = ?
    AND c.used_slots < c.total_slots
    AND c.supported_storage IN (?, 'normal')
  `).all(CabinetStatus.AVAILABLE, storageRequirement) as any[];

  if (preferredZone) {
    const zonePreferred = cabinets.filter(c => c.zone === preferredZone);
    if (zonePreferred.length > 0) {
      cabinets = zonePreferred;
    }
  }

  cabinets.sort((a, b) => {
    const aUsage = a.used_slots / a.total_slots;
    const bUsage = b.used_slots / b.total_slots;
    return aUsage - bUsage;
  });

  for (const cabinet of cabinets) {
    const existingSlot = db.prepare(`
      SELECT * FROM cabinet_slots
      WHERE cabinet_id = ?
      AND consumable_id = ?
      AND batch_no = ?
      AND status = 'occupied'
      AND locked = 0
      LIMIT 1
    `).get(cabinet.id, consumableId, batchNo) as any;

    if (existingSlot) {
      return {
        cabinet_id: cabinet.id,
        cabinet_code: cabinet.code,
        cabinet_name: cabinet.name,
        slot_id: existingSlot.id,
        slot_code: existingSlot.slot_code,
        layer: existingSlot.layer,
        position: existingSlot.position
      };
    }

    const emptySlot = db.prepare(`
      SELECT * FROM cabinet_slots
      WHERE cabinet_id = ?
      AND status = 'empty'
      AND locked = 0
      ORDER BY layer ASC, position ASC
      LIMIT 1
    `).get(cabinet.id) as any;

    if (emptySlot) {
      return {
        cabinet_id: cabinet.id,
        cabinet_code: cabinet.code,
        cabinet_name: cabinet.name,
        slot_id: emptySlot.id,
        slot_code: emptySlot.slot_code,
        layer: emptySlot.layer,
        position: emptySlot.position
      };
    }
  }

  return null;
}

export function updateSlotOccupancy(slotId: number, consumableId: number, batchNo: string, expiryDate: string, addQuantity: number): void {
  const db = getDatabase();

  const slot = db.prepare('SELECT * FROM cabinet_slots WHERE id = ?').get(slotId) as any;
  if (!slot) throw new Error('柜位不存在');

  const newQuantity = (slot.quantity || 0) + addQuantity;

  db.prepare(`
    UPDATE cabinet_slots
    SET consumable_id = ?, batch_no = ?, expiry_date = ?, quantity = ?,
        status = CASE WHEN ? > 0 THEN 'occupied' ELSE 'empty' END
    WHERE id = ?
  `).run(consumableId, batchNo, expiryDate, newQuantity, newQuantity, slotId);

  const cabinet = db.prepare('SELECT * FROM smart_cabinets WHERE id = ?').get(slot.cabinet_id) as any;
  if (cabinet) {
    const occupiedSlots = db.prepare(`
      SELECT COUNT(*) as count FROM cabinet_slots
      WHERE cabinet_id = ? AND status = 'occupied'
    `).get(slot.cabinet_id) as { count: number };

    const usedSlots = occupiedSlots.count;
    let status = CabinetStatus.AVAILABLE;
    if (usedSlots >= cabinet.total_slots) {
      status = CabinetStatus.OCCUPIED;
    } else if (usedSlots > 0) {
      status = CabinetStatus.PARTIAL;
    }

    db.prepare(`
      UPDATE smart_cabinets
      SET used_slots = ?, status = ?
      WHERE id = ?
    `).run(usedSlots, status, cabinet.id);
  }
}

export function getInventorySummary(): any[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT
      c.id as consumable_id,
      c.code as consumable_code,
      c.name as consumable_name,
      c.category,
      c.storage_requirement,
      SUM(i.quantity) as total_quantity,
      SUM(i.locked_quantity) as locked_quantity,
      SUM(i.quantity - i.locked_quantity) as available_quantity,
      COUNT(DISTINCT i.batch_no) as batch_count,
      MIN(i.expiry_date) as earliest_expiry
    FROM consumables c
    LEFT JOIN inventory i ON c.id = i.consumable_id
    GROUP BY c.id
    ORDER BY c.category, c.name
  `).all() as any[];
}

export function getInventoryByConsumable(consumableId: number): any[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT
      i.*,
      c.name as consumable_name,
      c.code as consumable_code,
      sc.code as cabinet_code,
      sc.name as cabinet_name,
      cs.slot_code,
      cs.layer,
      cs.position,
      s.name as supplier_name,
      s.code as supplier_code
    FROM inventory i
    LEFT JOIN consumables c ON i.consumable_id = c.id
    LEFT JOIN smart_cabinets sc ON i.cabinet_id = sc.id
    LEFT JOIN cabinet_slots cs ON i.slot_id = cs.id
    LEFT JOIN suppliers s ON i.supplier_id = s.id
    WHERE i.consumable_id = ?
    ORDER BY i.expiry_date ASC
  `).all(consumableId) as any[];
}

export function getExpiringInventory(days: number = 30): any[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT
      i.*,
      c.name as consumable_name,
      c.code as consumable_code,
      sc.code as cabinet_code,
      sc.name as cabinet_name,
      cs.slot_code,
      s.name as supplier_name
    FROM inventory i
    LEFT JOIN consumables c ON i.consumable_id = c.id
    LEFT JOIN smart_cabinets sc ON i.cabinet_id = sc.id
    LEFT JOIN cabinet_slots cs ON i.slot_id = cs.id
    LEFT JOIN suppliers s ON i.supplier_id = s.id
    WHERE i.quantity > 0
    AND DATE(i.expiry_date) <= DATE('now', 'localtime', '+' || ? || ' days')
    ORDER BY i.expiry_date ASC
  `).all(days) as any[];
}

export function checkInventoryLock(consumableId: number, quantity: number): { available: boolean; availableQuantity: number } {
  const db = getDatabase();
  const result = db.prepare(`
    SELECT
      SUM(quantity) as total,
      SUM(locked_quantity) as locked
    FROM inventory
    WHERE consumable_id = ? AND status = 'normal'
  `).get(consumableId) as { total: number | null; locked: number | null };

  const total = result.total || 0;
  const locked = result.locked || 0;
  const available = total - locked;

  return {
    available: available >= quantity,
    availableQuantity: available
  };
}

export function lockInventory(
  consumableId: number,
  quantity: number,
  requisitionId: number,
  useFifo: boolean = true
): { success: boolean; lockedItems: any[]; message?: string } {
  const db = getDatabase();
  const lockedItems: any[] = [];
  let remainingToLock = quantity;

  const orderClause = useFifo ? 'expiry_date ASC, created_at ASC' : 'expiry_date DESC, created_at ASC';

  const tx = db.transaction(() => {
    const availableItems = db.prepare(`
      SELECT * FROM inventory
      WHERE consumable_id = ?
      AND status = 'normal'
      AND (quantity - locked_quantity) > 0
      ORDER BY ${orderClause}
    `).all(consumableId) as any[];

    for (const item of availableItems) {
      if (remainingToLock <= 0) break;

      const itemAvailable = item.quantity - item.locked_quantity;
      const toLock = Math.min(itemAvailable, remainingToLock);

      db.prepare(`
        UPDATE inventory
        SET locked_quantity = locked_quantity + ?,
            updated_at = datetime('now', 'localtime')
        WHERE id = ?
      `).run(toLock, item.id);

      lockedItems.push({
        inventory_id: item.id,
        trace_code: item.trace_code,
        batch_no: item.batch_no,
        locked_quantity: toLock,
        cabinet_id: item.cabinet_id,
        slot_id: item.slot_id
      });

      remainingToLock -= toLock;
    }

    if (remainingToLock > 0) {
      throw new Error(`库存不足，还需要 ${remainingToLock} 个才能满足锁定需求`);
    }
  });

  try {
    tx();
    return { success: true, lockedItems };
  } catch (err: any) {
    return { success: false, lockedItems: [], message: err.message };
  }
}

export function unlockInventory(requisitionId: number): boolean {
  const db = getDatabase();
  return true;
}

export function consumeInventory(
  traceCode: string,
  quantity: number,
  requisitionId?: number
): { success: boolean; remaining: number; message?: string } {
  const db = getDatabase();

  const tx = db.transaction(() => {
    const item = db.prepare(`
      SELECT * FROM inventory WHERE trace_code = ?
    `).get(traceCode) as any;

    if (!item) {
      throw new Error('追溯码对应的库存不存在');
    }

    if (item.quantity < quantity) {
      throw new Error(`库存数量不足，当前库存: ${item.quantity}，需要: ${quantity}`);
    }

    const newQuantity = item.quantity - quantity;
    const newLocked = Math.max(0, item.locked_quantity - quantity);

    db.prepare(`
      UPDATE inventory
      SET quantity = ?,
          locked_quantity = ?,
          status = CASE WHEN ? <= 0 THEN 'depleted' ELSE 'normal' END,
          updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(newQuantity, newLocked, newQuantity, item.id);

    if (newQuantity <= 0) {
      db.prepare(`
        UPDATE cabinet_slots
        SET quantity = quantity - ?,
            status = CASE WHEN (quantity - ?) <= 0 THEN 'empty' ELSE status END,
            consumable_id = CASE WHEN (quantity - ?) <= 0 THEN NULL ELSE consumable_id END,
            batch_no = CASE WHEN (quantity - ?) <= 0 THEN NULL ELSE batch_no END
        WHERE id = ?
      `).run(quantity, quantity, quantity, quantity, item.slot_id);

      const slot = db.prepare('SELECT cabinet_id FROM cabinet_slots WHERE id = ?').get(item.slot_id) as any;
      if (slot) {
        const cabinet = db.prepare('SELECT total_slots FROM smart_cabinets WHERE id = ?').get(slot.cabinet_id) as any;
        if (cabinet) {
          const occupiedCount = db.prepare(`
            SELECT COUNT(*) as cnt FROM cabinet_slots
            WHERE cabinet_id = ? AND status = 'occupied'
          `).get(slot.cabinet_id) as { cnt: number };

          let status = CabinetStatus.AVAILABLE;
          if (occupiedCount.cnt >= cabinet.total_slots) {
            status = CabinetStatus.OCCUPIED;
          } else if (occupiedCount.cnt > 0) {
            status = CabinetStatus.PARTIAL;
          }

          db.prepare(`
            UPDATE smart_cabinets SET used_slots = ?, status = ? WHERE id = ?
          `).run(occupiedCount.cnt, status, slot.cabinet_id);
        }
      }
    }

    return newQuantity;
  });

  try {
    const remaining = tx();
    return { success: true, remaining };
  } catch (err: any) {
    return { success: false, remaining: 0, message: err.message };
  }
}
