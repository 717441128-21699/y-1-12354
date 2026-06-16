import { getDatabase } from '../database/connection';
import { StorageRequirement, CabinetStatus } from '../types';
import { daysUntilExpiry } from '../utils/date';
import { queryOperationLogs } from './operation-log.service';

export interface CabinetAllocation {
  cabinet_id: number;
  cabinet_code: string;
  cabinet_name: string;
  slot_id: number;
  slot_code: string;
  layer: number;
  position: number;
  storage_type?: string;
  storage_name?: string;
}

export interface AllocationResult {
  success: boolean;
  allocation?: CabinetAllocation;
  errorCode?: 'NO_CABINET_MATCH' | 'NO_SLOT_AVAILABLE' | 'CABINET_MAINTENANCE';
  errorDetail?: {
    requiredStorage: string;
    requiredStorageName: string;
    totalCabinetsInSystem: number;
    matchedCabinets: number;
    cabinetsWithSlots: number;
    zoneSearched?: string;
    cabinetStats?: Record<string, any>;
    maintenanceCabinets?: number;
    suggestion?: {
      type: string;
      title: string;
      description: string;
      configEntry: string;
      configEntryName: string;
    };
  };
}

const STORAGE_NAMES: Record<string, string> = {
  normal: '常温普通',
  refrigerated: '冷藏',
  frozen: '冷冻',
  light_protected: '避光',
  sterile: '无菌'
};

export function allocateCabinetSlot(
  consumableId: number,
  storageRequirement: StorageRequirement,
  batchNo: string,
  preferredZone?: string
): AllocationResult {
  const db = getDatabase();

  const storageName = STORAGE_NAMES[storageRequirement] || storageRequirement;

  const allCabinets = db.prepare(`
    SELECT
      supported_storage,
      COUNT(*) as total_cabinets,
      SUM(total_slots) as total_slots,
      SUM(used_slots) as used_slots,
      SUM(CASE WHEN status = 'maintenance' THEN 1 ELSE 0 END) as maintenance_cabinets
    FROM smart_cabinets
    GROUP BY supported_storage
  `).all() as any[];

  const cabinetStats: Record<string, any> = {};
  for (const c of allCabinets) {
    cabinetStats[c.supported_storage] = {
      storage_type: c.supported_storage,
      storage_name: STORAGE_NAMES[c.supported_storage] || c.supported_storage,
      total_cabinets: c.total_cabinets,
      total_slots: c.total_slots,
      used_slots: c.used_slots,
      available_slots: c.total_slots - c.used_slots,
      maintenance_cabinets: c.maintenance_cabinets
    };
  }

  const totalCabinetsInSystem = allCabinets.reduce((s, c) => s + c.total_cabinets, 0);

  let matchedCabinets = db.prepare(`
    SELECT c.* FROM smart_cabinets c
    WHERE c.status != ?
    AND c.supported_storage = ?
  `).all(CabinetStatus.MAINTENANCE, storageRequirement) as any[];

  const matchedCount = matchedCabinets.length;

  if (matchedCabinets.length === 0) {
    return {
      success: false,
      errorCode: 'NO_CABINET_MATCH',
      errorDetail: {
        requiredStorage: storageRequirement,
        requiredStorageName: storageName,
        totalCabinetsInSystem,
        matchedCabinets: 0,
        cabinetsWithSlots: 0,
        zoneSearched: preferredZone,
        cabinetStats,
        suggestion: {
          type: 'add_cabinet',
          title: `缺少${storageName}存储柜`,
          description: `当前系统中没有支持"${storageName}"存储要求的智能柜，请先在柜位管理中添加对应类型的柜子。`,
          configEntry: '/system/cabinets',
          configEntryName: '智能柜管理'
        }
      }
    };
  }

  if (preferredZone) {
    const zonePreferred = matchedCabinets.filter(c => c.zone === preferredZone);
    if (zonePreferred.length > 0) {
      matchedCabinets = zonePreferred;
    }
  }

  const cabinetsWithSlots = matchedCabinets.filter(c => c.used_slots < c.total_slots).length;

  matchedCabinets = matchedCabinets.filter(c => c.used_slots < c.total_slots);

  if (matchedCabinets.length === 0) {
    const maintenanceCabinets = db.prepare(`
      SELECT COUNT(*) as cnt
      FROM smart_cabinets
      WHERE supported_storage = ? AND status = ?
    `).get(storageRequirement, CabinetStatus.MAINTENANCE) as { cnt: number };

    return {
      success: false,
      errorCode: 'NO_SLOT_AVAILABLE',
      errorDetail: {
        requiredStorage: storageRequirement,
        requiredStorageName: storageName,
        totalCabinetsInSystem,
        matchedCabinets: matchedCount,
        cabinetsWithSlots: 0,
        zoneSearched: preferredZone,
        cabinetStats,
        maintenanceCabinets: maintenanceCabinets.cnt,
        suggestion: {
          type: 'expand_capacity',
          title: `${storageName}柜位已满`,
          description: `当前${matchedCount}个${storageName}智能柜的所有柜位都已占用，另有${maintenanceCabinets.cnt}个在维护中。请清理库存或扩容。`,
          configEntry: '/system/cabinets',
          configEntryName: '智能柜管理'
        }
      }
    };
  }

  matchedCabinets.sort((a, b) => {
    const aUsage = a.used_slots / a.total_slots;
    const bUsage = b.used_slots / b.total_slots;
    return aUsage - bUsage;
  });

  for (const cabinet of matchedCabinets) {
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
        success: true,
        allocation: {
          cabinet_id: cabinet.id,
          cabinet_code: cabinet.code,
          cabinet_name: cabinet.name,
          slot_id: existingSlot.id,
          slot_code: existingSlot.slot_code,
          layer: existingSlot.layer,
          position: existingSlot.position,
          storage_type: storageRequirement,
          storage_name: storageName
        }
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
        success: true,
        allocation: {
          cabinet_id: cabinet.id,
          cabinet_code: cabinet.code,
          cabinet_name: cabinet.name,
          slot_id: emptySlot.id,
          slot_code: emptySlot.slot_code,
          layer: emptySlot.layer,
          position: emptySlot.position,
          storage_type: storageRequirement,
          storage_name: storageName
        }
      };
    }
  }

  return {
    success: false,
    errorCode: 'NO_SLOT_AVAILABLE',
    errorDetail: {
      requiredStorage: storageRequirement,
      requiredStorageName: storageName,
      totalCabinetsInSystem,
      matchedCabinets: matchedCount,
      cabinetsWithSlots: matchedCabinets.length,
      zoneSearched: preferredZone,
      cabinetStats,
      suggestion: {
        type: 'expand_capacity',
        title: `${storageName}柜位已满`,
        description: `当前${matchedCount}个${storageName}智能柜的所有柜位都已占用，请清理库存或扩容。`,
        configEntry: '/system/cabinets',
        configEntryName: '智能柜管理'
      }
    }
  };
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

export interface InventoryListParams {
  consumableId?: number;
  cabinetId?: number;
  slotId?: number;
  batchNo?: string;
  status?: string;
  storageRequirement?: string;
  expiryFrom?: string;
  expiryTo?: string;
  nearExpiryOnly?: boolean;
  page?: number;
  pageSize?: number;
}

function enrichInventoryItem(item: any): any {
  if (!item) return item;
  const days = daysUntilExpiry(item.expiry_date);
  item.days_to_expiry = days;

  let statusLabel = '';
  let lockReason: string | null = null;
  let canOutbound = true;

  switch (item.status) {
    case 'normal':
      statusLabel = '正常';
      canOutbound = true;
      break;
    case 'near_expiry_locked':
      statusLabel = '临期锁定';
      canOutbound = false;
      lockReason = `距离效期剩余${days}天，不足30天已锁定禁止出库`;
      break;
    case 'scrapped':
      statusLabel = '已报废';
      canOutbound = false;
      lockReason = '耗材已报废处置';
      break;
    case 'depleted':
      statusLabel = '已耗尽';
      canOutbound = false;
      lockReason = '库存已消耗完毕';
      break;
    default:
      statusLabel = item.status || '未知';
      canOutbound = true;
  }

  item.status_label = statusLabel;
  item.lock_reason = lockReason;
  item.can_outbound = canOutbound;
  item.available_quantity = item.quantity - (item.locked_quantity || 0);

  if (item.storage_requirement) {
    item.storage_requirement_name = STORAGE_NAMES[item.storage_requirement] || item.storage_requirement;
  }
  if (item.cabinet_storage_type) {
    item.cabinet_storage_name = STORAGE_NAMES[item.cabinet_storage_type] || item.cabinet_storage_type;
  }

  return item;
}

export function getInventoryList(params: InventoryListParams = {}): { list: any[]; total: number } {
  const db = getDatabase();
  const conditions: string[] = [];
  const values: any[] = [];

  if (params.consumableId !== undefined) {
    conditions.push('i.consumable_id = ?');
    values.push(params.consumableId);
  }
  if (params.cabinetId !== undefined) {
    conditions.push('i.cabinet_id = ?');
    values.push(params.cabinetId);
  }
  if (params.slotId !== undefined) {
    conditions.push('i.slot_id = ?');
    values.push(params.slotId);
  }
  if (params.batchNo) {
    conditions.push('i.batch_no LIKE ?');
    values.push(`%${params.batchNo}%`);
  }
  if (params.status) {
    conditions.push('i.status = ?');
    values.push(params.status);
  }
  if (params.storageRequirement) {
    conditions.push('c.storage_requirement = ?');
    values.push(params.storageRequirement);
  }
  if (params.expiryFrom) {
    conditions.push('DATE(i.expiry_date) >= DATE(?)');
    values.push(params.expiryFrom);
  }
  if (params.expiryTo) {
    conditions.push('DATE(i.expiry_date) <= DATE(?)');
    values.push(params.expiryTo);
  }
  if (params.nearExpiryOnly) {
    conditions.push("DATE(i.expiry_date) <= DATE('now', 'localtime', '+30 days')");
    conditions.push("i.quantity > 0");
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const totalStmt = db.prepare(`
    SELECT COUNT(*) as total FROM inventory i
    LEFT JOIN consumables c ON i.consumable_id = c.id
    ${whereClause}
  `);
  const { total } = totalStmt.get(...values) as { total: number };

  const page = params.page || 1;
  const pageSize = params.pageSize || 20;
  const offset = (page - 1) * pageSize;

  const listStmt = db.prepare(`
    SELECT
      i.*,
      c.name as consumable_name,
      c.code as consumable_code,
      c.category as consumable_category,
      c.specification,
      c.unit,
      c.storage_requirement,
      sc.code as cabinet_code,
      sc.name as cabinet_name,
      sc.supported_storage as cabinet_storage_type,
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
    ${whereClause}
    ORDER BY i.expiry_date ASC, i.created_at DESC
    LIMIT ? OFFSET ?
  `);

  const rawList = listStmt.all(...values, pageSize, offset) as any[];
  const list = rawList.map(enrichInventoryItem);

  return { list, total };
}

export function getInventoryDetail(id: number): any | null {
  const db = getDatabase();
  const item = db.prepare(`
    SELECT
      i.*,
      c.name as consumable_name,
      c.code as consumable_code,
      c.category as consumable_category,
      c.specification,
      c.unit,
      c.storage_requirement,
      sc.code as cabinet_code,
      sc.name as cabinet_name,
      sc.supported_storage as cabinet_storage_type,
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
    WHERE i.id = ?
  `).get(id) as any;

  if (!item) return null;
  return enrichInventoryItem(item);
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

export function checkInventoryLock(consumableId: number, quantity: number): {
  available: boolean;
  availableQuantity: number;
  nearExpiryQuantity: number;
  lockedQuantity: number;
  normalTotal: number;
} {
  const db = getDatabase();
  const result = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'normal' THEN quantity ELSE 0 END) as normal_total,
      SUM(CASE WHEN status = 'normal' THEN locked_quantity ELSE 0 END) as normal_locked,
      SUM(CASE WHEN status = 'near_expiry_locked' THEN quantity ELSE 0 END) as near_expiry_total
    FROM inventory
    WHERE consumable_id = ?
  `).get(consumableId) as { normal_total: number | null; normal_locked: number | null; near_expiry_total: number | null };

  const normalTotal = result.normal_total || 0;
  const lockedQuantity = result.normal_locked || 0;
  const availableQuantity = normalTotal - lockedQuantity;
  const nearExpiryQuantity = result.near_expiry_total || 0;

  return {
    available: availableQuantity >= quantity,
    availableQuantity,
    nearExpiryQuantity,
    lockedQuantity,
    normalTotal
  };
}

export function lockInventory(
  consumableId: number,
  quantity: number,
  requisitionId: number,
  useFifo: boolean = true
): { success: boolean; lockedItems: any[]; message?: string; blockedByNearExpiry?: boolean; nearExpiryBlockedQty?: number } {
  const db = getDatabase();
  const lockedItems: any[] = [];
  let remainingToLock = quantity;

  const orderClause = useFifo ? 'expiry_date ASC, created_at ASC' : 'expiry_date DESC, created_at ASC';

  const nearExpiryResult = db.prepare(`
    SELECT COALESCE(SUM(quantity), 0) as near_qty
    FROM inventory
    WHERE consumable_id = ? AND status = 'near_expiry_locked'
  `).get(consumableId) as { near_qty: number };
  const nearExpiryQty = nearExpiryResult.near_qty;

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
        expiry_date: item.expiry_date,
        locked_quantity: toLock,
        cabinet_id: item.cabinet_id,
        slot_id: item.slot_id
      });

      remainingToLock -= toLock;
    }

    if (remainingToLock > 0) {
      if (nearExpiryQty > 0) {
        throw new Error(`NEAR_EXPIRY_BLOCKED: 可用库存不足，还需 ${remainingToLock} 个。另有 ${nearExpiryQty} 个因临近效期（30天内）被锁定不可出库，请更换批次或联系库房处理`);
      } else {
        throw new Error(`库存不足，还需要 ${remainingToLock} 个才能满足锁定需求`);
      }
    }
  });

  try {
    tx();
    return { success: true, lockedItems };
  } catch (err: any) {
    const msg: string = err.message || '';
    const isNearExpiryBlocked = msg.startsWith('NEAR_EXPIRY_BLOCKED:');
    return {
      success: false,
      lockedItems: [],
      message: isNearExpiryBlocked ? msg.replace('NEAR_EXPIRY_BLOCKED:', '').trim() : msg,
      blockedByNearExpiry: isNearExpiryBlocked,
      nearExpiryBlockedQty: isNearExpiryBlocked ? nearExpiryQty : undefined
    };
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

export function getInventoryDisposals(inventoryId: number): { list: any[]; total: number } {
  const db = getDatabase();
  const { list, total } = queryOperationLogs({
    relatedType: 'inventory',
    relatedId: inventoryId,
    page: 1,
    pageSize: 500
  });

  const inv = db.prepare(`
    SELECT i.*, c.name as consumable_name, c.code as consumable_code, c.unit
    FROM inventory i
    LEFT JOIN consumables c ON i.consumable_id = c.id
    WHERE i.id = ?
  `).get(inventoryId) as any;

  const enriched = list.map(log => {
    let parsed: any = {};
    try {
      parsed = JSON.parse(log.detail || '{}');
    } catch (_) {}
    const source = log.operator_role === 'system'
      ? { type: 'system', label: '系统自动触发', name: log.operator_name || '系统' }
      : { type: 'manual', label: '人工操作', name: log.operator_name || '未知', id: log.operator_id, role: log.operator_role };

    return {
      id: log.id,
      biz_type: log.biz_type,
      action: log.action,
      title: log.title,
      detail: log.detail,
      source,
      operator_name: log.operator_name,
      operator_role: log.operator_role,
      created_at: log.created_at,
      inventory: inv ? {
        id: inv.id,
        batch_no: inv.batch_no,
        trace_code: inv.trace_code,
        quantity: inv.quantity,
        consumable_name: inv.consumable_name,
        consumable_code: inv.consumable_code
      } : null,
      batch_no: inv?.batch_no,
      trace_code: inv?.trace_code,
      quantity: inv?.quantity,
      disposal_no: (log.detail || '').match(/处置单[：:]\s*([A-Z0-9-]+)/)?.[1] || null,
      status: log.status,
      old_value: log.old_value,
      new_value: log.new_value
    };
  });

  return { list: enriched, total };
}

export function getInventoryTimeline(inventoryId: number): { summary: any; events: any[] } {
  const db = getDatabase();
  const { list } = queryOperationLogs({
    relatedType: 'inventory',
    relatedId: inventoryId,
    page: 1,
    pageSize: 500
  });

  const inventory = getInventoryDetail(inventoryId);

  const eventTypeMap: Record<string, { type: string; label: string; icon: string; severity: string }> = {
    create: { type: 'stock_in', label: '入库', icon: '📥', severity: 'success' },
    alert: { type: 'expiry_alert', label: '效期预警', icon: '⚠️', severity: 'warning' },
    lock: { type: 'requisition_lock', label: '锁定', icon: '🔒', severity: 'info' },
    unlock: { type: 'requisition_unlock', label: '解锁', icon: '🔓', severity: 'info' },
    consume: { type: 'consume', label: '消耗', icon: '⚡', severity: 'primary' },
    return: { type: 'return', label: '退还', icon: '↩️', severity: 'primary' },
    scrap: { type: 'scrap', label: '报废', icon: '🗑️', severity: 'danger' },
    inventory_check: { type: 'check', label: '巡检', icon: '🔍', severity: 'secondary' },
    update: { type: 'update', label: '更新', icon: '📝', severity: 'secondary' }
  };

  const events = list.map((log, idx) => {
    const meta = eventTypeMap[log.action] || { type: log.action, label: log.action, icon: '📋', severity: 'secondary' };
    return {
      sequence: list.length - idx,
      id: log.id,
      timestamp: log.created_at,
      event_type: meta.type,
      event_label: meta.label,
      icon: meta.icon,
      severity: meta.severity,
      title: log.title,
      detail: log.detail,
      operator: {
        name: log.operator_name,
        role: log.operator_role,
        is_system: log.operator_role === 'system'
      },
      status: log.status,
      change: {
        old_value: log.old_value,
        new_value: log.new_value
      }
    };
  });

  return {
    summary: {
      inventory,
      total_events: events.length,
      event_counts: events.reduce((acc: any, e) => {
        acc[e.event_type] = (acc[e.event_type] || 0) + 1;
        return acc;
      }, {})
    },
    events
  };
}
