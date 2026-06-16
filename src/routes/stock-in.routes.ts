import { Router, Request, Response } from 'express';
import { getDatabase } from '../database/connection';
import { success, fail } from '../utils/response';
import {
  createStockInRequest,
  auditStockInRequest,
  completeStockIn,
  getStockInList,
  checkSupplierQualification,
  checkRegistrationCert
} from '../services/stock-in.service';

const router = Router();

router.post('/requests', (req: Request, res: Response) => {
  const body = req.body;
  const required = ['supplierId', 'consumableId', 'batchNo', 'quantity', 'unitPrice', 'expiryDate', 'createdBy'];
  const missing = required.filter(k => !(k in body));

  if (missing.length > 0) {
    return res.json(fail(`缺少必填参数: ${missing.join(', ')}`));
  }

  const result = createStockInRequest({
    supplierId: Number(body.supplierId),
    consumableId: Number(body.consumableId),
    batchNo: body.batchNo,
    quantity: Number(body.quantity),
    unitPrice: Number(body.unitPrice),
    productionDate: body.productionDate,
    expiryDate: body.expiryDate,
    createdBy: Number(body.createdBy)
  });

  res.json(result.success ? success(result.data, result.message) : fail(result.message, 400, result));
});

router.post('/requests/:id/audit', (req: Request, res: Response) => {
  const { approved, auditorId, rejectReason } = req.body;

  if (auditorId === undefined) {
    return res.json(fail('缺少审核人ID'));
  }
  if (approved === undefined) {
    return res.json(fail('缺少审核结果'));
  }

  const result = auditStockInRequest(
    Number(req.params.id),
    Number(auditorId),
    Boolean(approved),
    rejectReason
  );

  res.json(result.success ? success(result.data, result.message) : fail(result.message));
});

router.post('/requests/:id/complete', (req: Request, res: Response) => {
  const result = completeStockIn(Number(req.params.id));
  res.json(result.success ? success(null, result.message) : fail(result.message));
});

router.get('/requests', (req: Request, res: Response) => {
  const { status, supplierId, consumableId, page, pageSize } = req.query;

  const result = getStockInList({
    status: status as string,
    supplierId: supplierId ? Number(supplierId) : undefined,
    consumableId: consumableId ? Number(consumableId) : undefined,
    page: page ? Number(page) : undefined,
    pageSize: pageSize ? Number(pageSize) : undefined
  });

  res.json(success(result));
});

router.get('/requests/:id', (req: Request, res: Response) => {
  const db = getDatabase();
  const request = db.prepare(`
    SELECT sr.*,
           s.name as supplier_name, s.code as supplier_code,
           s.business_license_expiry, s.medical_device_license_expiry, s.qualification_status,
           c.name as consumable_name, c.code as consumable_code, c.category, c.unit, c.price,
           c.registration_cert_no, c.registration_cert_expiry, c.storage_requirement,
           sc.code as cabinet_code, sc.name as cabinet_name,
           cs.slot_code, cs.layer, cs.position,
           ua.name as created_by_name,
           u2.name as auditor_name
    FROM stock_in_requests sr
    LEFT JOIN suppliers s ON sr.supplier_id = s.id
    LEFT JOIN consumables c ON sr.consumable_id = c.id
    LEFT JOIN smart_cabinets sc ON sr.cabinet_id = sc.id
    LEFT JOIN cabinet_slots cs ON sr.slot_id = cs.id
    LEFT JOIN users ua ON sr.created_by = ua.id
    LEFT JOIN users u2 ON sr.auditor_id = u2.id
    WHERE sr.id = ?
  `).get(req.params.id);

  if (!request) return res.json(fail('入库申请不存在'));
  res.json(success(request));
});

router.get('/check/supplier/:id', (req: Request, res: Response) => {
  const result = checkSupplierQualification(Number(req.params.id));
  res.json(success(result));
});

router.get('/check/registration/:consumableId', (req: Request, res: Response) => {
  const result = checkRegistrationCert(Number(req.params.consumableId));
  res.json(success(result));
});

export default router;
