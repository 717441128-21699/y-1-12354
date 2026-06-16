import { Router, Request, Response } from 'express';
import { success, fail } from '../utils/response';
import {
  generateDailyReport,
  getDepartmentReports,
  getCategorySummary,
  exportReportToExcel
} from '../services/report.service';
import fs from 'fs';
import path from 'path';

const router = Router();

router.post('/generate-daily', (req: Request, res: Response) => {
  const { reportDate } = req.body;
  const result = generateDailyReport(reportDate);
  res.json(result.success ? success(result.data, result.message) : fail(result.message));
});

router.get('/department', (req: Request, res: Response) => {
  const { startDate, endDate, departmentId, category, page, pageSize } = req.query;

  if (!startDate || !endDate) {
    return res.json(fail('缺少必要参数: startDate, endDate'));
  }

  const result = getDepartmentReports({
    startDate: startDate as string,
    endDate: endDate as string,
    departmentId: departmentId ? Number(departmentId) : undefined,
    category: category as string,
    page: page ? Number(page) : undefined,
    pageSize: pageSize ? Number(pageSize) : undefined
  });

  res.json(success(result));
});

router.get('/category-summary', (req: Request, res: Response) => {
  const { startDate, endDate, departmentId } = req.query;

  if (!startDate || !endDate) {
    return res.json(fail('缺少必要参数: startDate, endDate'));
  }

  const result = getCategorySummary({
    startDate: startDate as string,
    endDate: endDate as string,
    departmentId: departmentId ? Number(departmentId) : undefined
  });

  res.json(success(result));
});

router.get('/export', async (req: Request, res: Response) => {
  const { startDate, endDate, departmentId, category, exportType } = req.query;

  if (!startDate || !endDate) {
    return res.json(fail('缺少必要参数: startDate, endDate'));
  }

  const result = await exportReportToExcel({
    startDate: startDate as string,
    endDate: endDate as string,
    departmentId: departmentId ? Number(departmentId) : undefined,
    category: category as string,
    exportType: exportType as any
  });

  if (result.success && result.filePath) {
    const fileName = path.basename(result.filePath);
    const exportDir = path.join(__dirname, '../../exports');

    if (fs.existsSync(result.filePath)) {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
      return fs.createReadStream(result.filePath).pipe(res);
    }
  }

  res.json(result.success ? success({ filePath: result.filePath }, result.message) : fail(result.message));
});

router.get('/download/:filename', (req: Request, res: Response) => {
  const fileName = req.params.filename;
  const filePath = path.join(__dirname, '../../exports', fileName);

  if (!fs.existsSync(filePath)) {
    return res.json(fail('文件不存在'));
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
  fs.createReadStream(filePath).pipe(res);
});

export default router;
