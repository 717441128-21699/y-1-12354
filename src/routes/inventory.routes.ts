import { Router, Request, Response } from 'express';
import { success, fail } from '../utils/response';
import {
  recordConsumption,
  autoInventoryByCabinet,
  returnUnusedConsumables,
  getConsumptionList
} from '../services/consumption.service';
import {
  checkAndHandleExpiry,
  manualDispose,
  getActiveAlerts,
  getDisposalList
} from '../services/expiry.service';
import {
  getNotifications,
  getUnreadNotifications,
  markNotificationAsRead,
  batchMarkNotificationsRead,
  markAllNotificationsRead,
  getNotificationTypes,
  handleAlert
} from '../utils/notification';
import {
  queryOperationLogs,
  getOperationLog,
  BizType
} from '../services/operation-log.service';
import {
  getInventoryList,
  getInventoryDetail
} from '../services/cabinet.service';
import { AlertType, AlertStatus } from '../types';

const router = Router();

router.post('/consumption', (req: Request, res: Response) => {
  const body = req.body;
  const required = ['traceCode', 'consumableId', 'cabinetId', 'slotId', 'quantityUsed', 'operatorId'];
  const missing = required.filter(k => !(k in body));

  if (missing.length > 0) {
    return res.json(fail(`缺少必填参数: ${missing.join(', ')}`));
  }

  const result = recordConsumption({
    requisitionId: body.requisitionId ? Number(body.requisitionId) : undefined,
    traceCode: body.traceCode,
    consumableId: Number(body.consumableId),
    cabinetId: Number(body.cabinetId),
    slotId: Number(body.slotId),
    quantityUsed: Number(body.quantityUsed),
    patientId: body.patientId,
    surgeryId: body.surgeryId,
    operatorId: Number(body.operatorId),
    operatorName: body.operatorName
  });

  res.json(result.success ? success(result.data, result.message) : fail(result.message));
});

router.post('/cabinet/:id/inventory', (req: Request, res: Response) => {
  const result = autoInventoryByCabinet(Number(req.params.id));
  res.json(result.success ? success(result.data, result.message) : fail(result.message));
});

router.post('/return', (req: Request, res: Response) => {
  const { traceCode, returnQuantity, operatorId, operatorName } = req.body;

  if (!traceCode || !returnQuantity || !operatorId) {
    return res.json(fail('缺少必要参数: traceCode, returnQuantity, operatorId'));
  }

  const result = returnUnusedConsumables(
    traceCode,
    Number(returnQuantity),
    Number(operatorId),
    operatorName
  );

  res.json(result.success ? success(null, result.message) : fail(result.message));
});

router.get('/consumption', (req: Request, res: Response) => {
  const { startDate, endDate, consumableId, cabinetId, requisitionId, page, pageSize } = req.query;

  const result = getConsumptionList({
    startDate: startDate as string,
    endDate: endDate as string,
    consumableId: consumableId ? Number(consumableId) : undefined,
    cabinetId: cabinetId ? Number(cabinetId) : undefined,
    requisitionId: requisitionId ? Number(requisitionId) : undefined,
    page: page ? Number(page) : undefined,
    pageSize: pageSize ? Number(pageSize) : undefined
  });

  res.json(success(result));
});

router.post('/expiry/check', (req: Request, res: Response) => {
  const result = checkAndHandleExpiry();
  res.json(success(result, `效期检查完成：创建${result.alertsCreated}条预警，锁定${result.itemsLocked}项，报废${result.itemsScrapped}项`));
});

router.post('/disposal', (req: Request, res: Response) => {
  const { inventoryIds, reason, handlerId, handlerName } = req.body;

  if (!inventoryIds || !Array.isArray(inventoryIds) || inventoryIds.length === 0) {
    return res.json(fail('请选择要报废的库存ID列表'));
  }
  if (!reason || !handlerId) {
    return res.json(fail('缺少报废原因或处理人ID'));
  }

  const result = manualDispose(
    (inventoryIds as any[]).map(Number),
    reason,
    Number(handlerId),
    handlerName
  );

  res.json(result.success ? success(result.data, result.message) : fail(result.message));
});

router.get('/alerts', (req: Request, res: Response) => {
  const { type, status, page, pageSize } = req.query;

  const result = getActiveAlerts({
    type: type as AlertType,
    status: status as AlertStatus,
    page: page ? Number(page) : undefined,
    pageSize: pageSize ? Number(pageSize) : undefined
  });

  res.json(success(result));
});

router.post('/alerts/:id/handle', (req: Request, res: Response) => {
  const handled = handleAlert(Number(req.params.id));
  res.json(handled ? success(null, '预警已处理') : fail('预警不存在或处理失败'));
});

router.get('/disposals', (req: Request, res: Response) => {
  const { startDate, endDate, consumableId, page, pageSize } = req.query;

  const result = getDisposalList({
    startDate: startDate as string,
    endDate: endDate as string,
    consumableId: consumableId ? Number(consumableId) : undefined,
    page: page ? Number(page) : undefined,
    pageSize: pageSize ? Number(pageSize) : undefined
  });

  res.json(success(result));
});

router.get('/notifications', (req: Request, res: Response) => {
  const { roles, type, relatedType, readStatus, startDate, endDate, page, pageSize } = req.query;
  const roleList = roles ? (roles as string).split(',') : undefined;

  const result = getNotifications({
    roles: roleList,
    type: type as string,
    relatedType: relatedType as string,
    readStatus: (readStatus as 'unread' | 'read' | 'all') || 'unread',
    startDate: startDate as string,
    endDate: endDate as string,
    page: page ? Number(page) : undefined,
    pageSize: pageSize ? Number(pageSize) : undefined
  });

  res.json(success(result));
});

router.get('/notifications/types', (_req: Request, res: Response) => {
  const types = getNotificationTypes();
  res.json(success(types));
});

router.post('/notifications/:id/read', (req: Request, res: Response) => {
  const marked = markNotificationAsRead(Number(req.params.id));
  res.json(marked ? success(null, '已标记为已读') : fail('标记失败或已经是已读状态'));
});

router.post('/notifications/batch-read', (req: Request, res: Response) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.json(fail('请提供要标记的通知ID列表'));
  }
  const result = batchMarkNotificationsRead(ids.map(Number));
  res.json(success(result, `成功标记 ${result.success} 条已读`));
});

router.post('/notifications/read-all', (req: Request, res: Response) => {
  const { roles } = req.body;
  const roleList = roles && Array.isArray(roles) ? roles : undefined;
  const count = markAllNotificationsRead(roleList);
  res.json(success({ count }, `已将 ${count} 条未读消息全部标记为已读`));
});

router.get('/inventory', (req: Request, res: Response) => {
  const {
    consumableId, cabinetId, slotId, batchNo, status,
    storageRequirement, expiryFrom, expiryTo,
    nearExpiryOnly, page, pageSize
  } = req.query;

  const result = getInventoryList({
    consumableId: consumableId ? Number(consumableId) : undefined,
    cabinetId: cabinetId ? Number(cabinetId) : undefined,
    slotId: slotId ? Number(slotId) : undefined,
    batchNo: batchNo as string,
    status: status as string,
    storageRequirement: storageRequirement as string,
    expiryFrom: expiryFrom as string,
    expiryTo: expiryTo as string,
    nearExpiryOnly: nearExpiryOnly === 'true',
    page: page ? Number(page) : undefined,
    pageSize: pageSize ? Number(pageSize) : undefined
  });

  res.json(success(result));
});

router.get('/inventory/:id', (req: Request, res: Response) => {
  const item = getInventoryDetail(Number(req.params.id));
  if (!item) return res.json(fail('库存记录不存在'));
  res.json(success(item));
});

router.get('/operation-logs', (req: Request, res: Response) => {
  const {
    bizType, action, relatedType, relatedId,
    operatorId, operatorRole, startDate, endDate,
    page, pageSize
  } = req.query;

  const result = queryOperationLogs({
    bizType: bizType as string,
    action: action as string,
    relatedType: relatedType as string,
    relatedId: relatedId ? Number(relatedId) : undefined,
    operatorId: operatorId ? Number(operatorId) : undefined,
    operatorRole: operatorRole as string,
    startDate: startDate as string,
    endDate: endDate as string,
    page: page ? Number(page) : undefined,
    pageSize: pageSize ? Number(pageSize) : undefined
  });

  res.json(success(result));
});

router.get('/operation-logs/:id', (req: Request, res: Response) => {
  const log = getOperationLog(Number(req.params.id));
  if (!log) return res.json(fail('操作日志不存在'));
  res.json(success(log));
});

export default router;
