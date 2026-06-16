import { getDatabase } from '../database/connection';
import { RequisitionStatus } from '../types';
import { generateRequisitionNo } from '../utils/trace-code';
import { lockInventory, checkInventoryLock } from './cabinet.service';
import { sendNotification } from '../utils/notification';
import { logOperation, BizType, LogAction } from './operation-log.service';

export interface RequisitionCreateRequest {
  departmentId: number;
  applicantId: number;
  patientId?: string;
  patientName?: string;
  patientHistory?: string;
  surgeryId?: string;
  surgeryScheduleDate?: string;
  consumableId: number;
  requestedQuantity: number;
}

export interface UsageEstimation {
  historicalAverage: number;
  estimatedQuantity: number;
  isOverLimit: boolean;
  overLimitPercent: number;
  threshold: number;
  splitSuggestion?: string;
  reasons: string[];
}

export function calculateHistoricalAverage(
  departmentId: number,
  consumableId: number,
  days: number = 90
): number {
  const db = getDatabase();

  const result = db.prepare(`
    SELECT AVG(daily_total) as avg_usage
    FROM (
      SELECT DATE(cr.used_at) as use_date, SUM(cr.quantity_used) as daily_total
      FROM consumption_records cr
      LEFT JOIN requisitions r ON cr.requisition_id = r.id
      WHERE cr.consumable_id = ?
      AND r.department_id = ?
      AND cr.used_at >= datetime('now', 'localtime', '-' || ? || ' days')
      AND cr.status = 'used'
      GROUP BY DATE(cr.used_at)
    ) daily_stats
  `).get(consumableId, departmentId, days) as { avg_usage: number | null };

  return result.avg_usage || 0;
}

export function estimateUsage(
  departmentId: number,
  consumableId: number,
  requestedQuantity: number,
  surgeryScheduleDate?: string,
  patientHistory?: string
): UsageEstimation {
  const historicalAvg = calculateHistoricalAverage(departmentId, consumableId);
  const reasons: string[] = [];
  let estimated = historicalAvg > 0 ? historicalAvg : requestedQuantity;

  if (surgeryScheduleDate) {
    const surgeryDate = new Date(surgeryScheduleDate);
    const today = new Date();
    const daysToSurgery = Math.ceil((surgeryDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

    if (daysToSurgery >= 0 && daysToSurgery <= 7) {
      estimated = estimated * 1.2;
      reasons.push('近期手术排期（7天内），预估用量增加20%');
    }
  }

  if (patientHistory) {
    const hasHighRisk = /糖尿病|高血压|冠心病|免疫|出血|感染/i.test(patientHistory);
    if (hasHighRisk) {
      estimated = estimated * 1.3;
      reasons.push('患者存在高危因素（糖尿病/高血压/冠心病/免疫问题等），预估用量增加30%');
    }

    const isRevision = /返修|翻修|二次|复发|并发症/i.test(patientHistory);
    if (isRevision) {
      estimated = estimated * 1.5;
      reasons.push('患者为返修/翻修手术，预估用量增加50%');
    }
  }

  estimated = Math.ceil(estimated);
  if (estimated < 1) estimated = 1;

  const threshold = historicalAvg > 0 ? historicalAvg * 1.3 : requestedQuantity;
  const isOverLimit = requestedQuantity > threshold;
  const overLimitPercent = historicalAvg > 0
    ? ((requestedQuantity - historicalAvg) / historicalAvg) * 100
    : 0;

  let splitSuggestion: string | undefined;
  if (isOverLimit) {
    const firstBatch = Math.ceil(threshold);
    const remaining = requestedQuantity - firstBatch;
    splitSuggestion = `建议拆分为两批：首批${firstBatch}个（在安全范围内），剩余${remaining}个单独申请，需额外审批说明超量原因`;
    reasons.push(`申请量${requestedQuantity}超出历史均值${historicalAvg.toFixed(2)}的30%阈值${threshold.toFixed(2)}，超出${overLimitPercent.toFixed(1)}%`);
  }

  if (reasons.length === 0) {
    reasons.push(`基于过去90天历史均值（${historicalAvg.toFixed(2)}）计算`);
  }

  return {
    historicalAverage: historicalAvg,
    estimatedQuantity: estimated,
    isOverLimit,
    overLimitPercent,
    threshold,
    splitSuggestion,
    reasons
  };
}

export function createRequisition(request: RequisitionCreateRequest): {
  success: boolean;
  message: string;
  data?: any;
  estimation?: UsageEstimation;
  inventoryCheck?: { available: boolean; availableQuantity: number };
} {
  const db = getDatabase();

  const department = db.prepare('SELECT * FROM departments WHERE id = ?').get(request.departmentId) as any;
  const applicant = db.prepare('SELECT * FROM users WHERE id = ?').get(request.applicantId) as any;
  const consumable = db.prepare('SELECT * FROM consumables WHERE id = ?').get(request.consumableId) as any;

  if (!department || !applicant || !consumable) {
    return { success: false, message: '科室/申请人/耗材信息无效' };
  }

  const estimation = estimateUsage(
    request.departmentId,
    request.consumableId,
    request.requestedQuantity,
    request.surgeryScheduleDate,
    request.patientHistory
  );

  const invCheck = checkInventoryLock(request.consumableId, request.requestedQuantity);

  const requisitionNo = generateRequisitionNo();

  let status = RequisitionStatus.SUBMITTED;
  if (estimation.isOverLimit) {
    status = RequisitionStatus.QUANTITY_BLOCKED;
  }

  const tx = db.transaction(() => {
    const stmt = db.prepare(`
      INSERT INTO requisitions (
        requisition_no, department_id, department_name,
        applicant_id, applicant_name,
        patient_id, patient_name, patient_history,
        surgery_id, surgery_schedule_date,
        consumable_id, consumable_name,
        requested_quantity, estimated_quantity, historical_average,
        is_over_limit, over_limit_reason, split_suggestion,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      requisitionNo,
      request.departmentId,
      department.name,
      request.applicantId,
      applicant.name,
      request.patientId || null,
      request.patientName || null,
      request.patientHistory || null,
      request.surgeryId || null,
      request.surgeryScheduleDate || null,
      request.consumableId,
      consumable.name,
      request.requestedQuantity,
      estimation.estimatedQuantity,
      estimation.historicalAverage,
      estimation.isOverLimit ? 1 : 0,
      estimation.reasons.join('；'),
      estimation.splitSuggestion || null,
      status
    );

    return Number(result.lastInsertRowid);
  });

  const requisitionId = tx();

  const notifyRoles = estimation.isOverLimit
    ? ['department_head', 'warehouse_manager', 'operating_room_nurse']
    : ['department_head', 'warehouse_manager', 'operating_room_nurse'];

  sendNotification({
    type: estimation.isOverLimit ? 'requisition_over_limit' : 'requisition_created',
    title: estimation.isOverLimit ? '领用申请超量待审批' : '新领用申请待审核',
    content: `领用申请【${requisitionNo}】${applicant.name}申请${consumable.name} x ${request.requestedQuantity}${consumable.unit}${
      estimation.isOverLimit
        ? `，超历史均值${estimation.overLimitPercent.toFixed(1)}%，${estimation.splitSuggestion || ''}`
        : ''
    }${!invCheck.available ? `，库存不足（当前可用:${invCheck.availableQuantity}）` : ''}`,
    relatedType: 'requisition',
    relatedId: requisitionId,
    recipientRoles: notifyRoles
  });

  logOperation({
    bizType: BizType.REQUISITION,
    action: LogAction.CREATE,
    title: estimation.isOverLimit ? '领用申请创建（超量）' : '领用申请创建',
    detail: `${consumable.name} x ${request.requestedQuantity}${consumable.unit}，申请人：${applicant.name}`,
    relatedType: 'requisition',
    relatedId: requisitionId,
    operatorId: request.applicantId,
    operatorName: applicant.name,
    operatorRole: applicant.role,
    status
  });

  return {
    success: true,
    message: status === RequisitionStatus.QUANTITY_BLOCKED
      ? '申请已提交，但因超出历史均值30%，已触发拦截，需科室和库房双重审批'
      : '申请已提交，待科室审核',
    data: {
      id: requisitionId,
      requisition_no: requisitionNo,
      status,
      department_name: department.name,
      applicant_name: applicant.name,
      consumable_name: consumable.name
    },
    estimation,
    inventoryCheck: invCheck
  };
}

export function approveRequisitionByDepartment(
  requisitionId: number,
  approverId: number,
  approved: boolean,
  comment?: string
): { success: boolean; message: string; failReason?: string; data?: any } {
  const db = getDatabase();

  const req = db.prepare('SELECT * FROM requisitions WHERE id = ?').get(requisitionId) as any;
  if (!req) return { success: false, message: '领用申请不存在' };

  const validStatuses = [RequisitionStatus.SUBMITTED, RequisitionStatus.QUANTITY_BLOCKED];
  if (!validStatuses.includes(req.status as RequisitionStatus)) {
    return { success: false, message: `当前状态（${req.status}）不允许科室审核` };
  }

  const approver = db.prepare('SELECT * FROM users WHERE id = ?').get(approverId) as any;

  const tx = db.transaction(() => {
    if (approved) {
      let nextStatus: RequisitionStatus;
      if (req.status === RequisitionStatus.QUANTITY_BLOCKED) {
        nextStatus = RequisitionStatus.QUANTITY_APPROVED;
      } else {
        nextStatus = RequisitionStatus.DEPARTMENT_APPROVED;
      }

      db.prepare(`
        UPDATE requisitions
        SET status = ?,
            department_approver_id = ?,
            department_approver_name = ?,
            department_approved_at = datetime('now', 'localtime'),
            department_comment = ?,
            updated_at = datetime('now', 'localtime')
        WHERE id = ?
      `).run(nextStatus, approverId, approver?.name, comment || null, requisitionId);

      return nextStatus;
    } else {
      db.prepare(`
        UPDATE requisitions
        SET status = ?,
            department_approver_id = ?,
            department_approver_name = ?,
            department_approved_at = datetime('now', 'localtime'),
            department_comment = ?,
            reject_reason = ?,
            updated_at = datetime('now', 'localtime')
        WHERE id = ?
      `).run(
        RequisitionStatus.DEPARTMENT_REJECTED,
        approverId,
        approver?.name,
        comment || null,
        comment || '科室审核未通过',
        requisitionId
      );
      return RequisitionStatus.DEPARTMENT_REJECTED;
    }
  });

  const nextStatus = tx();

  sendNotification({
    type: approved ? 'requisition_department_approved' : 'requisition_rejected',
    title: approved ? '科室审核通过' : '领用申请被退回',
    content: `领用申请【${req.requisition_no}】${approved ? `科室审核通过，${nextStatus === RequisitionStatus.QUANTITY_APPROVED ? '待库房超量审批' : '待库房审批'}` : `已被退回：${comment || '科室审核未通过'}`}`,
    relatedType: 'requisition',
    relatedId: requisitionId,
    recipientRoles: approved
      ? (nextStatus === RequisitionStatus.QUANTITY_APPROVED ? ['warehouse_manager', 'operating_room_nurse'] : ['warehouse_manager', 'operating_room_nurse'])
      : ['warehouse_manager', 'operating_room_nurse']
  });

  logOperation({
    bizType: BizType.REQUISITION,
    action: approved ? LogAction.APPROVE : LogAction.REJECT,
    title: approved ? '科室审核通过' : '科室审核退回',
    detail: approved ? undefined : `原因：${comment || '科室审核未通过'}`,
    relatedType: 'requisition',
    relatedId: requisitionId,
    operatorId: approverId,
    operatorName: approver?.name,
    operatorRole: approver?.role,
    oldValue: req.status,
    newValue: nextStatus,
    status: nextStatus
  });

  return {
    success: true,
    message: approved
      ? (nextStatus === RequisitionStatus.QUANTITY_APPROVED ? '科室审核通过，待库房超量审批' : '科室审核通过，待库房审批')
      : '领用申请已退回',
    data: { id: requisitionId, status: nextStatus }
  };
}

export function approveRequisitionFinal(
  requisitionId: number,
  approverId: number,
  approved: boolean,
  comment?: string
): { success: boolean; message: string; failReason?: string; data?: any } {
  const db = getDatabase();

  const req = db.prepare('SELECT * FROM requisitions WHERE id = ?').get(requisitionId) as any;
  if (!req) return { success: false, message: '领用申请不存在' };

  const validStatuses = [RequisitionStatus.DEPARTMENT_APPROVED, RequisitionStatus.QUANTITY_APPROVED];
  if (!validStatuses.includes(req.status as RequisitionStatus)) {
    return { success: false, message: `当前状态（${req.status}）不允许最终审批` };
  }

  const approver = db.prepare('SELECT * FROM users WHERE id = ?').get(approverId) as any;

  if (approved) {
    const invSummary = checkInventoryLock(req.consumable_id, req.requested_quantity);
    const lockResult = lockInventory(req.consumable_id, req.requested_quantity, requisitionId);

    if (!lockResult.success) {
      const failReason = lockResult.blockedByNearExpiry ? 'near_expiry' : 'insufficient_stock';
      logOperation({
        bizType: BizType.REQUISITION,
        action: LogAction.LOCK,
        title: '库存锁定失败',
        detail: failReason === 'near_expiry'
          ? `可用${invSummary.availableQuantity}个，另有${lockResult.nearExpiryBlockedQty}个因临期锁定，无法满足${req.requested_quantity}个`
          : `可用${invSummary.availableQuantity}个，需求${req.requested_quantity}个，库存不足`,
        relatedType: 'requisition',
        relatedId: requisitionId,
        operatorId: approverId,
        operatorName: approver?.name,
        operatorRole: approver?.role,
        status: req.status
      });

      return {
        success: false,
        message: lockResult.message || '库存锁定失败',
        failReason,
        data: {
          id: requisitionId,
          status: req.status,
          blockedReason: failReason,
          requestedQuantity: req.requested_quantity,
          availableQuantity: invSummary.availableQuantity,
          lockedQuantity: invSummary.lockedQuantity,
          nearExpiryQuantity: invSummary.nearExpiryQuantity,
          blockedByNearExpiry: lockResult.blockedByNearExpiry,
          nearExpiryBlockedQty: lockResult.nearExpiryBlockedQty,
          suggestion: failReason === 'near_expiry'
            ? '请减少申领数量或更换其他批次'
            : '当前库存不足，请联系库房补货',
          diagnosis: {
            type: 'stock_lock',
            failReason,
            inventory: {
              requested: req.requested_quantity,
              available: invSummary.availableQuantity,
              alreadyLocked: invSummary.lockedQuantity,
              nearExpiryLocked: invSummary.nearExpiryQuantity,
              normalTotal: invSummary.normalTotal
            },
            suggestion: {
              text: failReason === 'near_expiry'
                ? '请减少申领数量或更换其他批次'
                : '当前库存不足，请联系库房补货',
              action: failReason === 'near_expiry' ? 'reduce_or_switch_batch' : 'request_restock'
            }
          }
        }
      };
    }

    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE requisitions
        SET status = ?,
            final_approver_id = ?,
            final_approver_name = ?,
            final_approved_at = datetime('now', 'localtime'),
            final_comment = ?,
            locked_stock = ?,
            updated_at = datetime('now', 'localtime')
        WHERE id = ?
      `).run(
        RequisitionStatus.STOCK_LOCKED,
        approverId,
        approver?.name,
        comment || null,
        req.requested_quantity,
        requisitionId
      );
    });

    tx();

    sendNotification({
      type: 'requisition_stock_locked',
      title: '库存已锁定，等待领用',
      content: `领用申请【${req.requisition_no}】${req.consumable_name} x ${req.requested_quantity} 库存已锁定，可前往智能柜取用`,
      relatedType: 'requisition',
      relatedId: requisitionId,
      recipientRoles: ['warehouse_manager', 'operating_room_nurse']
    });

    logOperation({
      bizType: BizType.REQUISITION,
      action: LogAction.LOCK,
      title: '最终审批通过，库存已锁定',
      detail: `${req.consumable_name} x ${req.requested_quantity}，锁定${lockResult.lockedItems.length}个批次`,
      relatedType: 'requisition',
      relatedId: requisitionId,
      operatorId: approverId,
      operatorName: approver?.name,
      operatorRole: approver?.role,
      oldValue: req.status,
      newValue: RequisitionStatus.STOCK_LOCKED,
      status: RequisitionStatus.STOCK_LOCKED
    });

    for (const locked of lockResult.lockedItems) {
      logOperation({
        bizType: BizType.INVENTORY,
        action: LogAction.LOCK,
        title: '库存被领用锁定',
        detail: `【${req.consumable_name}】批次${locked.batch_no}，追溯码${locked.trace_code}，锁定${locked.locked_quantity}个，关联领用申请【${req.requisition_no}】ID:${requisitionId}`,
        relatedType: 'inventory',
        relatedId: locked.inventory_id,
        operatorId: approverId,
        operatorName: approver?.name,
        operatorRole: approver?.role,
        oldValue: '0',
        newValue: String(locked.locked_quantity),
        status: 'locked'
      });
    }

    return {
      success: true,
      message: '审批通过，库存已锁定',
      data: {
        id: requisitionId,
        status: RequisitionStatus.STOCK_LOCKED,
        locked_stock: req.requested_quantity,
        availableQuantity: invSummary.availableQuantity,
        nearExpiryQuantity: invSummary.nearExpiryQuantity,
        locked_items: lockResult.lockedItems
      }
    };
  } else {
    db.prepare(`
      UPDATE requisitions
      SET status = ?,
          final_approver_id = ?,
          final_approver_name = ?,
          final_approved_at = datetime('now', 'localtime'),
          final_comment = ?,
          reject_reason = ?,
          updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(
      RequisitionStatus.REJECTED,
      approverId,
      approver?.name,
      comment || null,
      comment || '审批未通过',
      requisitionId
    );

    sendNotification({
      type: 'requisition_rejected',
      title: '领用申请被退回',
      content: `领用申请【${req.requisition_no}】最终审批未通过：${comment || '审批未通过'}`,
      relatedType: 'requisition',
      relatedId: requisitionId,
      recipientRoles: ['warehouse_manager', 'operating_room_nurse']
    });

    return {
      success: true,
      message: '领用申请已退回',
      data: { id: requisitionId, status: RequisitionStatus.REJECTED }
    };
  }
}

export function getRequisitionList(params: {
  status?: string; departmentId?: number; applicantId?: number; page?: number; pageSize?: number
} = {}): { list: any[]; total: number } {
  const db = getDatabase();
  const conditions: string[] = [];
  const values: any[] = [];

  if (params.status) {
    conditions.push('r.status = ?');
    values.push(params.status);
  }
  if (params.departmentId) {
    conditions.push('r.department_id = ?');
    values.push(params.departmentId);
  }
  if (params.applicantId) {
    conditions.push('r.applicant_id = ?');
    values.push(params.applicantId);
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const countStmt = db.prepare(`SELECT COUNT(*) as total FROM requisitions r ${whereClause}`);
  const { total } = countStmt.get(...values) as { total: number };

  const page = params.page || 1;
  const pageSize = params.pageSize || 20;
  const offset = (page - 1) * pageSize;

  const listStmt = db.prepare(`
    SELECT r.*,
           d.name as department_name,
           ua.name as applicant_user_name,
           c.code as consumable_code, c.category, c.unit, c.price
    FROM requisitions r
    LEFT JOIN departments d ON r.department_id = d.id
    LEFT JOIN users ua ON r.applicant_id = ua.id
    LEFT JOIN consumables c ON r.consumable_id = c.id
    ${whereClause}
    ORDER BY r.created_at DESC
    LIMIT ? OFFSET ?
  `);

  const list = listStmt.all(...values, pageSize, offset) as any[];

  return { list, total };
}

export function getRequisitionDetail(id: number): any | null {
  const db = getDatabase();

  const req = db.prepare(`
    SELECT r.*,
           d.name as department_name,
           ua.name as applicant_user_name, ua.phone as applicant_phone,
           c.code as consumable_code, c.category, c.unit, c.price,
           c.manufacturer, c.registration_cert_no, c.storage_requirement
    FROM requisitions r
    LEFT JOIN departments d ON r.department_id = d.id
    LEFT JOIN users ua ON r.applicant_id = ua.id
    LEFT JOIN consumables c ON r.consumable_id = c.id
    WHERE r.id = ?
  `).get(id) as any;

  if (!req) return null;

  const consumptions = db.prepare(`
    SELECT * FROM consumption_records WHERE requisition_id = ? ORDER BY used_at DESC
  `).all(id) as any[];

  return { ...req, consumptions };
}
