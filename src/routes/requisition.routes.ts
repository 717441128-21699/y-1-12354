import { Router, Request, Response } from 'express';
import { success, fail } from '../utils/response';
import {
  createRequisition,
  approveRequisitionByDepartment,
  approveRequisitionFinal,
  getRequisitionList,
  getRequisitionDetail,
  estimateUsage,
  calculateHistoricalAverage
} from '../services/requisition.service';

const router = Router();

router.post('/', (req: Request, res: Response) => {
  const body = req.body;
  const required = ['departmentId', 'applicantId', 'consumableId', 'requestedQuantity'];
  const missing = required.filter(k => !(k in body));

  if (missing.length > 0) {
    return res.json(fail(`缺少必填参数: ${missing.join(', ')}`));
  }

  const result = createRequisition({
    departmentId: Number(body.departmentId),
    applicantId: Number(body.applicantId),
    patientId: body.patientId,
    patientName: body.patientName,
    patientHistory: body.patientHistory,
    surgeryId: body.surgeryId,
    surgeryScheduleDate: body.surgeryScheduleDate,
    consumableId: Number(body.consumableId),
    requestedQuantity: Number(body.requestedQuantity)
  });

  res.json(result.success ? success(result.data, result.message) : fail(result.message, 400, result));
});

router.post('/:id/approve-department', (req: Request, res: Response) => {
  const { approved, approverId, comment } = req.body;

  if (approverId === undefined || approved === undefined) {
    return res.json(fail('缺少审核人ID或审核结果'));
  }

  const result = approveRequisitionByDepartment(
    Number(req.params.id),
    Number(approverId),
    Boolean(approved),
    comment
  );

  res.json(result.success ? success(result.data, result.message) : fail(result.message));
});

router.post('/:id/approve-final', (req: Request, res: Response) => {
  const { approved, approverId, comment } = req.body;

  if (approverId === undefined || approved === undefined) {
    return res.json(fail('缺少审批人ID或审批结果'));
  }

  const result = approveRequisitionFinal(
    Number(req.params.id),
    Number(approverId),
    Boolean(approved),
    comment
  );

  res.json(result.success ? success(result.data, result.message) : fail(result.message));
});

router.get('/', (req: Request, res: Response) => {
  const { status, departmentId, applicantId, page, pageSize } = req.query;

  const result = getRequisitionList({
    status: status as string,
    departmentId: departmentId ? Number(departmentId) : undefined,
    applicantId: applicantId ? Number(applicantId) : undefined,
    page: page ? Number(page) : undefined,
    pageSize: pageSize ? Number(pageSize) : undefined
  });

  res.json(success(result));
});

router.get('/:id', (req: Request, res: Response) => {
  const detail = getRequisitionDetail(Number(req.params.id));
  if (!detail) return res.json(fail('领用申请不存在'));
  res.json(success(detail));
});

router.get('/estimate/usage', (req: Request, res: Response) => {
  const { departmentId, consumableId, quantity, surgeryDate, patientHistory } = req.query;

  if (!departmentId || !consumableId || !quantity) {
    return res.json(fail('缺少必要参数: departmentId, consumableId, quantity'));
  }

  const result = estimateUsage(
    Number(departmentId),
    Number(consumableId),
    Number(quantity),
    surgeryDate as string,
    patientHistory as string
  );

  res.json(success(result));
});

router.get('/historical-average', (req: Request, res: Response) => {
  const { departmentId, consumableId, days } = req.query;

  if (!departmentId || !consumableId) {
    return res.json(fail('缺少必要参数: departmentId, consumableId'));
  }

  const avg = calculateHistoricalAverage(
    Number(departmentId),
    Number(consumableId),
    days ? Number(days) : 90
  );

  res.json(success({ historical_average: avg }));
});

export default router;
