import { getDatabase } from '../database/connection';
import { SupplierQualificationStatus, StockInStatus, StorageRequirement } from '../types';
import { daysUntilExpiry } from '../utils/date';
import { generateRequestNo, generateTraceCode } from '../utils/trace-code';
import { allocateCabinetSlot, updateSlotOccupancy } from './cabinet.service';
import { sendNotification } from '../utils/notification';
import { logOperation, BizType, LogAction } from './operation-log.service';

export interface QualificationCheckResult {
  valid: boolean;
  issues: string[];
  supplierStatus: SupplierQualificationStatus;
}

export interface StockInCreateRequest {
  supplierId: number;
  consumableId: number;
  batchNo: string;
  quantity: number;
  unitPrice: number;
  productionDate?: string;
  expiryDate: string;
  createdBy: number;
}

export function checkSupplierQualification(supplierId: number): QualificationCheckResult {
  const db = getDatabase();
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supplierId) as any;

  if (!supplier) {
    return {
      valid: false,
      issues: ['供应商不存在'],
      supplierStatus: SupplierQualificationStatus.INVALID
    };
  }

  const issues: string[] = [];
  let overallStatus = SupplierQualificationStatus.VALID;

  const now = new Date();
  const today = new Date(now.toISOString().split('T')[0]);

  if (supplier.business_license_expiry) {
    const expiryDays = daysUntilExpiry(supplier.business_license_expiry);
    if (expiryDays < 0) {
      issues.push(`营业执照已过期（过期时间：${supplier.business_license_expiry}）`);
      overallStatus = SupplierQualificationStatus.EXPIRED;
    } else if (expiryDays <= 30) {
      issues.push(`营业执照将在${expiryDays}天后过期（过期时间：${supplier.business_license_expiry}）`);
      if (overallStatus === SupplierQualificationStatus.VALID) {
        overallStatus = SupplierQualificationStatus.VALID;
      }
    }
  } else {
    issues.push('营业执照信息缺失');
    overallStatus = SupplierQualificationStatus.INVALID;
  }

  if (supplier.medical_device_license_expiry) {
    const expiryDays = daysUntilExpiry(supplier.medical_device_license_expiry);
    if (expiryDays < 0) {
      issues.push(`医疗器械经营许可证已过期（过期时间：${supplier.medical_device_license_expiry}）`);
      overallStatus = SupplierQualificationStatus.EXPIRED;
    } else if (expiryDays <= 30) {
      issues.push(`医疗器械经营许可证将在${expiryDays}天后过期（过期时间：${supplier.medical_device_license_expiry}）`);
    }
  } else {
    issues.push('医疗器械经营许可证信息缺失');
    if (overallStatus === SupplierQualificationStatus.VALID) {
      overallStatus = SupplierQualificationStatus.INVALID;
    }
  }

  if (supplier.qualification_status === SupplierQualificationStatus.EXPIRED ||
      supplier.qualification_status === SupplierQualificationStatus.INVALID) {
    overallStatus = supplier.qualification_status;
    if (!issues.includes('供应商资质状态无效')) {
      issues.unshift(`供应商资质${supplier.qualification_status === SupplierQualificationStatus.EXPIRED ? '已过期' : '无效'}：${supplier.qualification_status}`);
    }
  }

  return {
    valid: overallStatus === SupplierQualificationStatus.VALID,
    issues,
    supplierStatus: overallStatus
  };
}

export function checkRegistrationCert(consumableId: number): { valid: boolean; issues: string[] } {
  const db = getDatabase();
  const consumable = db.prepare('SELECT * FROM consumables WHERE id = ?').get(consumableId) as any;

  if (!consumable) {
    return { valid: false, issues: ['耗材信息不存在'] };
  }

  const issues: string[] = [];

  if (!consumable.registration_cert_no) {
    issues.push('产品注册证号缺失');
  }

  if (consumable.registration_cert_expiry) {
    const expiryDays = daysUntilExpiry(consumable.registration_cert_expiry);
    if (expiryDays < 0) {
      issues.push(`产品注册证已过期（过期时间：${consumable.registration_cert_expiry}）`);
    } else if (expiryDays <= 90) {
      issues.push(`产品注册证将在${expiryDays}天后过期（过期时间：${consumable.registration_cert_expiry}）`);
    }
  } else {
    issues.push('产品注册证有效期缺失');
  }

  return {
    valid: issues.length === 0 || !issues.some(i => i.includes('已过期') && !i.includes('将在')),
    issues
  };
}

export function checkExpiryDateValid(expiryDate: string, productionDate?: string): { valid: boolean; issues: string[] } {
  const issues: string[] = [];

  const expiryDays = daysUntilExpiry(expiryDate);
  if (expiryDays <= 0) {
    issues.push(`耗材已过期（有效期至：${expiryDate}）`);
  } else if (expiryDays <= 30) {
    issues.push(`耗材有效期不足30天（有效期至：${expiryDate}，剩余${expiryDays}天）`);
  }

  if (productionDate) {
    const prod = new Date(productionDate);
    const exp = new Date(expiryDate);
    if (prod > exp) {
      issues.push('生产日期晚于有效期');
    }
  }

  return {
    valid: !issues.some(i => i.includes('已过期') || i.includes('生产日期晚于有效期')),
    issues
  };
}

export function createStockInRequest(request: StockInCreateRequest): {
  success: boolean;
  message: string;
  data?: any;
  qualificationCheck?: QualificationCheckResult;
  certCheck?: { valid: boolean; issues: string[] };
  expiryCheck?: { valid: boolean; issues: string[] };
} {
  const db = getDatabase();

  const supplierCheck = checkSupplierQualification(request.supplierId);
  const certCheck = checkRegistrationCert(request.consumableId);
  const expiryCheck = checkExpiryDateValid(request.expiryDate, request.productionDate);

  const allIssues = [
    ...supplierCheck.issues.filter(i => i.includes('已过期') || i.includes('不存在') || i.includes('无效') || i.includes('缺失') && !i.includes('将在')),
    ...certCheck.issues.filter(i => i.includes('已过期') || i.includes('不存在')),
    ...expiryCheck.issues.filter(i => i.includes('已过期') || i.includes('生产日期晚于有效期'))
  ];

  const requestNo = generateRequestNo('SI');

  let status = StockInStatus.PENDING;
  let rejectReason: string | null = null;

  if (!supplierCheck.valid || !certCheck.valid || !expiryCheck.valid) {
    status = StockInStatus.REJECTED;
    rejectReason = allIssues.join('；');
  }

  const consumable = db.prepare('SELECT * FROM consumables WHERE id = ?').get(request.consumableId) as any;
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(request.supplierId) as any;

  const tx = db.transaction(() => {
    const stmt = db.prepare(`
      INSERT INTO stock_in_requests (
        request_no, supplier_id, consumable_id, batch_no, quantity,
        unit_price, production_date, expiry_date, status, reject_reason, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      requestNo,
      request.supplierId,
      request.consumableId,
      request.batchNo,
      request.quantity,
      request.unitPrice,
      request.productionDate || null,
      request.expiryDate,
      status,
      rejectReason,
      request.createdBy
    );

    return Number(result.lastInsertRowid);
  });

  const requestId = tx();

  if (status === StockInStatus.REJECTED) {
    sendNotification({
      type: 'stock_in_rejected',
      title: '入库申请被退回',
      content: `入库申请【${requestNo}】因资质校验未通过，原因：${rejectReason}`,
      relatedType: 'stock_in',
      relatedId: requestId,
        recipientRoles: ['warehouse_manager', 'operating_room_nurse']
    });

    logOperation({
      bizType: BizType.STOCK_IN,
      action: LogAction.REJECT,
      title: '入库申请被退回',
      detail: `原因：${rejectReason}`,
      relatedType: 'stock_in',
      relatedId: requestId,
      operatorRole: 'system',
      operatorName: '系统自动校验',
      status
    });

    return {
      success: false,
      message: '入库申请已退回',
      data: { id: requestId, request_no: requestNo, status },
      qualificationCheck: supplierCheck,
      certCheck,
      expiryCheck
    };
  }

  sendNotification({
    type: 'stock_in_created',
    title: '新入库申请待审核',
    content: `收到新的入库申请【${requestNo}】${consumable?.name} x ${request.quantity}${consumable?.unit}，待审核`,
    relatedType: 'stock_in',
    relatedId: requestId,
    recipientRoles: ['warehouse_manager', 'operating_room_nurse']
  });

  logOperation({
    bizType: BizType.STOCK_IN,
    action: LogAction.CREATE,
    title: '创建入库申请',
    detail: `${consumable?.name} x ${request.quantity}${consumable?.unit}，供应商：${supplier?.name}`,
    relatedType: 'stock_in',
    relatedId: requestId,
    operatorId: request.createdBy,
    operatorRole: 'system',
    status
  });

  return {
    success: true,
    message: '入库申请创建成功，待审核',
    data: {
      id: requestId,
      request_no: requestNo,
      status,
      supplier_name: supplier?.name,
      consumable_name: consumable?.name
    },
    qualificationCheck: supplierCheck,
    certCheck,
    expiryCheck
  };
}

export function auditStockInRequest(
  requestId: number,
  auditorId: number,
  approved: boolean,
  rejectReason?: string
): { success: boolean; message: string; data?: any } {
  const db = getDatabase();

  const request = db.prepare('SELECT * FROM stock_in_requests WHERE id = ?').get(requestId) as any;
  if (!request) {
    return { success: false, message: '入库申请不存在' };
  }

  if (request.status !== StockInStatus.PENDING) {
    return { success: false, message: "Current status does not allow audit: " + request.status };
  }

  const tx = db.transaction(() => {
    if (approved) {
      const consumable = db.prepare('SELECT * FROM consumables WHERE id = ?').get(request.consumable_id) as any;
      const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(request.supplier_id) as any;

      const allocationResult = allocateCabinetSlot(
        request.consumable_id,
        consumable.storage_requirement,
        request.batch_no
      );

      if (!allocationResult.success || !allocationResult.allocation) {
        const detail = allocationResult.errorDetail;
        const reason = allocationResult.errorCode === 'NO_CABINET_MATCH'
          ? `系统中无支持【${detail?.requiredStorageName || consumable.storage_requirement}】存储条件的智能柜。`
          : `支持【${detail?.requiredStorageName || consumable.storage_requirement}】存储的智能柜暂无空闲柜位。`;
        const err: any = new Error(reason);
        err.errorCode = allocationResult.errorCode;
        err.errorDetail = detail;
        throw err;
      }

      const allocation = allocationResult.allocation;

      const traceCode = generateTraceCode(
        consumable.code,
        request.batch_no,
        supplier.code,
        allocation.cabinet_code,
        allocation.slot_code
      );

      db.prepare(`
        UPDATE stock_in_requests
        SET status = ?, auditor_id = ?, audited_at = datetime('now', 'localtime'),
            cabinet_id = ?, slot_id = ?, trace_code = ?
        WHERE id = ?
      `).run(
        StockInStatus.APPROVED, auditorId, allocation.cabinet_id, allocation.slot_id, traceCode, requestId
      );

      updateSlotOccupancy(
        allocation.slot_id,
        request.consumable_id,
        request.batch_no,
        request.expiry_date,
        request.quantity
      );

      db.prepare(`
        INSERT INTO inventory (
          consumable_id, cabinet_id, slot_id, supplier_id, batch_no, trace_code,
          quantity, production_date, expiry_date, unit_price, stock_in_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        request.consumable_id,
        allocation.cabinet_id,
        allocation.slot_id,
        request.supplier_id,
        request.batch_no,
        traceCode,
        request.quantity,
        request.production_date,
        request.expiry_date,
        request.unit_price,
        requestId
      );

      return { allocation, traceCode };
    } else {
      db.prepare(`
        UPDATE stock_in_requests
        SET status = ?, reject_reason = ?, auditor_id = ?, audited_at = datetime('now', 'localtime')
        WHERE id = ?
      `).run(StockInStatus.REJECTED, rejectReason || '审核未通过', auditorId, requestId);
    }
  });

  try {
    const result = tx() as any;
    if (approved) {
      sendNotification({
        type: 'stock_in_approved',
        title: '入库审核通过',
        content: `入库申请【${request.request_no}】审核通过，已分配至${result.allocation.cabinet_name} - ${result.allocation.slot_code}，追溯码：${result.traceCode}`,
        relatedType: 'stock_in',
        relatedId: requestId,
        recipientRoles: ['warehouse_manager', 'operating_room_nurse']
      });

      logOperation({
        bizType: BizType.STOCK_IN,
        action: LogAction.APPROVE,
        title: '入库审核通过',
        detail: `已分配至${result.allocation.cabinet_name} - ${result.allocation.slot_code}，追溯码：${result.traceCode}`,
        relatedType: 'stock_in',
        relatedId: requestId,
        operatorId: auditorId,
        operatorRole: 'warehouse_manager',
        oldValue: request.status,
        newValue: StockInStatus.APPROVED,
        status: StockInStatus.APPROVED
      });

      return {
        success: true,
        message: '入库审核通过，已分配柜位并生成追溯码',
        data: {
          id: requestId,
          request_no: request.request_no,
          status: StockInStatus.APPROVED,
          cabinet_id: result.allocation.cabinet_id,
          cabinet_name: result.allocation.cabinet_name,
          slot_id: result.allocation.slot_id,
          slot_code: result.allocation.slot_code,
          trace_code: result.traceCode,
          storage_requirement: result.allocation.storage_type
        }
      };
    } else {
      sendNotification({
        type: 'stock_in_rejected',
        title: '入库申请被退回',
        content: `入库申请【${request.request_no}】审核未通过，原因：${rejectReason || '审核未通过'}`,
        relatedType: 'stock_in',
        relatedId: requestId,
          recipientRoles: ['warehouse_manager', 'operating_room_nurse']
      });

      logOperation({
        bizType: BizType.STOCK_IN,
        action: LogAction.REJECT,
        title: '入库审核退回',
        detail: `原因：${rejectReason || '审核未通过'}`,
        relatedType: 'stock_in',
        relatedId: requestId,
        operatorId: auditorId,
        operatorRole: 'warehouse_manager',
        oldValue: request.status,
        newValue: StockInStatus.REJECTED,
        status: StockInStatus.REJECTED
      });

      return {
        success: true,
        message: '入库申请已退回',
        data: { id: requestId, status: StockInStatus.REJECTED }
      };
    }
  } catch (err: any) {
    const msg: string = err.message || '';
    const errorCode = err.errorCode;
    const errorDetail = err.errorDetail;
    const resp: any = { success: false, message: msg };

    if (errorCode === 'NO_CABINET_MATCH') {
      resp.data = {
        errorCode: 'NO_CABINET_MATCH',
        errorCategory: 'cabinet_allocation',
        errorDetail,
        id: requestId,
        status: StockInStatus.PENDING
      };
    } else if (errorCode === 'NO_SLOT_AVAILABLE') {
      resp.data = {
        errorCode: 'NO_SLOT_AVAILABLE',
        errorCategory: 'cabinet_allocation',
        errorDetail,
        id: requestId,
        status: StockInStatus.PENDING
      };
    }

    return resp;
  }
}

export function completeStockIn(requestId: number): { success: boolean; message: string } {
  const db = getDatabase();

  const request = db.prepare('SELECT * FROM stock_in_requests WHERE id = ?').get(requestId) as any;
  if (!request) return { success: false, message: '入库申请不存在' };

  if (request.status !== StockInStatus.APPROVED) {
    return { success: false, message: '当前状态不允许完成入库' };
  }

  db.prepare(`
    UPDATE stock_in_requests
    SET status = ?, completed_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(StockInStatus.COMPLETED, requestId);

  return { success: true, message: '入库完成' };
}

export function getStockInList(params: {
  status?: string; supplierId?: number; consumableId?: number; page?: number; pageSize?: number
} = {}): { list: any[]; total: number } {
  const db = getDatabase();
  const conditions: string[] = [];
  const values: any[] = [];

  if (params.status) {
    conditions.push('sr.status = ?');
    values.push(params.status);
  }
  if (params.supplierId) {
    conditions.push('sr.supplier_id = ?');
    values.push(params.supplierId);
  }
  if (params.consumableId) {
    conditions.push('sr.consumable_id = ?');
    values.push(params.consumableId);
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const countStmt = db.prepare(`SELECT COUNT(*) as total FROM stock_in_requests sr ${whereClause}`);
  const { total } = countStmt.get(...values) as { total: number };

  const page = params.page || 1;
  const pageSize = params.pageSize || 20;
  const offset = (page - 1) * pageSize;

  const listStmt = db.prepare(`
    SELECT sr.*,
           s.name as supplier_name, s.code as supplier_code,
           c.name as consumable_name, c.code as consumable_code, c.category,
           sc.code as cabinet_code, sc.name as cabinet_name,
           cs.slot_code,
           ua.name as created_by_name,
           u2.name as auditor_name
    FROM stock_in_requests sr
    LEFT JOIN suppliers s ON sr.supplier_id = s.id
    LEFT JOIN consumables c ON sr.consumable_id = c.id
    LEFT JOIN smart_cabinets sc ON sr.cabinet_id = sc.id
    LEFT JOIN cabinet_slots cs ON sr.slot_id = cs.id
    LEFT JOIN users ua ON sr.created_by = ua.id
    LEFT JOIN users u2 ON sr.auditor_id = u2.id
    ${whereClause}
    ORDER BY sr.created_at DESC
    LIMIT ? OFFSET ?
  `);

  const list = listStmt.all(...values, pageSize, offset) as any[];

  return { list, total };
}
