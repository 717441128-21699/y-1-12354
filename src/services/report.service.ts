import { getDatabase } from '../database/connection';
import { ExcelColumn, exportToExcel } from '../utils/excel-exporter';
import { formatDate } from '../utils/date';
import { sendNotification } from '../utils/notification';

export interface DailyReportParams {
  reportDate?: string;
  departmentId?: number;
  category?: string;
}

export function generateDailyReport(reportDate?: string): {
  success: boolean;
  message: string;
  data?: {
    reportDate: string;
    totalRecords: number;
    totalAmount: number;
    departmentSummaries: any[];
  };
} {
  const db = getDatabase();

  const date = reportDate || formatDate(new Date(), 'YYYY-MM-DD');
  const prevDate = formatDate(new Date(new Date(date).getTime() - 24 * 60 * 60 * 1000), 'YYYY-MM-DD');

  const tx = db.transaction(() => {
    const consumptionData = db.prepare(`
      SELECT
        r.department_id,
        r.department_name,
        cr.consumable_id,
        c.name as consumable_name,
        c.category,
        c.price as unit_price,
        c.unit,
        SUM(cr.quantity_used) as usage_quantity
      FROM consumption_records cr
      LEFT JOIN requisitions r ON cr.requisition_id = r.id
      LEFT JOIN consumables c ON cr.consumable_id = c.id
      WHERE DATE(cr.used_at) = ?
      AND cr.status IN ('used', 'partial')
      AND cr.quantity_used > 0
      GROUP BY r.department_id, cr.consumable_id
    `).all(date) as any[];

    const totalAmount = consumptionData.reduce(
      (sum, item) => sum + (item.usage_quantity * item.unit_price), 0
    );

    for (const record of consumptionData) {
      if (!record.department_id) continue;

      const openingStock = getOpeningStock(record.consumable_id, prevDate);
      const closingStock = getOpeningStock(record.consumable_id, date);

      const avgStock = (openingStock + closingStock) / 2 || 1;
      const turnoverRate = avgStock > 0 ? record.usage_quantity / avgStock : 0;

      db.prepare(`
        INSERT OR REPLACE INTO department_reports (
          report_date, department_id, department_name,
          consumable_id, consumable_name, category,
          usage_quantity, usage_amount,
          opening_stock, closing_stock, turnover_rate, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
      `).run(
        date,
        record.department_id,
        record.department_name,
        record.consumable_id,
        record.consumable_name,
        record.category,
        record.usage_quantity,
        record.usage_quantity * record.unit_price,
        openingStock,
        closingStock,
        Number(turnoverRate.toFixed(4))
      );
    }

    const deptSummary = db.prepare(`
      SELECT
        department_id,
        department_name,
        COUNT(DISTINCT consumable_id) as consumable_count,
        SUM(usage_quantity) as total_quantity,
        SUM(usage_amount) as total_amount,
        AVG(turnover_rate) as avg_turnover
      FROM department_reports
      WHERE report_date = ?
      GROUP BY department_id
      ORDER BY total_amount DESC
    `).all(date) as any[];

    return {
      consumptionData,
      deptSummary,
      totalRecords: consumptionData.length,
      totalAmount
    };
  });

  const result = tx();

  sendNotification({
    type: 'daily_report_ready',
    title: `日报表已生成（${date}）`,
    content: `【${date}】耗材使用日报已生成，共${result.totalRecords}条记录，总金额￥${result.totalAmount.toFixed(2)}，涉及${result.deptSummary.length}个科室`,
    relatedType: 'report',
    recipientRoles: ['warehouse_manager', 'admin']
  });

  return {
    success: true,
    message: `日报表生成完成，共${result.totalRecords}条记录`,
    data: {
      reportDate: date,
      totalRecords: result.totalRecords,
      totalAmount: result.totalAmount,
      departmentSummaries: result.deptSummary
    }
  };
}

function getOpeningStock(consumableId: number, date: string): number {
  const db = getDatabase();

  const stockIn = db.prepare(`
    SELECT COALESCE(SUM(quantity), 0) as total
    FROM inventory
    WHERE consumable_id = ?
    AND DATE(created_at) <= ?
  `).get(consumableId, date) as { total: number };

  const consumed = db.prepare(`
    SELECT COALESCE(SUM(quantity_used), 0) as total
    FROM consumption_records
    WHERE consumable_id = ?
    AND DATE(used_at) <= ?
    AND quantity_used > 0
  `).get(consumableId, date) as { total: number };

  const scrapped = db.prepare(`
    SELECT COALESCE(SUM(dr.quantity), 0) as total
    FROM disposal_records dr
    WHERE dr.consumable_id = ?
    AND DATE(dr.created_at) <= ?
  `).get(consumableId, date) as { total: number };

  return stockIn.total - consumed.total - scrapped.total;
}

export function getDepartmentReports(params: {
  startDate: string;
  endDate: string;
  departmentId?: number;
  category?: string;
  page?: number;
  pageSize?: number;
}): { list: any[]; total: number; summary: any } {
  const db = getDatabase();
  const conditions: string[] = ['dr.report_date >= ?', 'dr.report_date <= ?'];
  const values: any[] = [params.startDate, params.endDate];

  if (params.departmentId) {
    conditions.push('dr.department_id = ?');
    values.push(params.departmentId);
  }
  if (params.category) {
    conditions.push('dr.category = ?');
    values.push(params.category);
  }

  const whereClause = 'WHERE ' + conditions.join(' AND ');

  const summary = db.prepare(`
    SELECT
      COUNT(DISTINCT dr.department_id) as dept_count,
      COUNT(DISTINCT dr.consumable_id) as consumable_count,
      COALESCE(SUM(dr.usage_quantity), 0) as total_quantity,
      COALESCE(SUM(dr.usage_amount), 0) as total_amount,
      COALESCE(AVG(dr.turnover_rate), 0) as avg_turnover
    FROM department_reports dr
    ${whereClause}
  `).get(...values) as any;

  const countStmt = db.prepare(`SELECT COUNT(*) as total FROM department_reports dr ${whereClause}`);
  const { total } = countStmt.get(...values) as { total: number };

  const page = params.page || 1;
  const pageSize = params.pageSize || 50;
  const offset = (page - 1) * pageSize;

  const listStmt = db.prepare(`
    SELECT dr.*,
           c.code as consumable_code, c.unit
    FROM department_reports dr
    LEFT JOIN consumables c ON dr.consumable_id = c.id
    ${whereClause}
    ORDER BY dr.report_date DESC, dr.usage_amount DESC
    LIMIT ? OFFSET ?
  `);

  const list = listStmt.all(...values, pageSize, offset) as any[];

  return { list, total, summary };
}

export function getCategorySummary(params: {
  startDate: string;
  endDate: string;
  departmentId?: number;
}): any[] {
  const db = getDatabase();
  const conditions: string[] = ['dr.report_date >= ?', 'dr.report_date <= ?'];
  const values: any[] = [params.startDate, params.endDate];

  if (params.departmentId) {
    conditions.push('dr.department_id = ?');
    values.push(params.departmentId);
  }

  const whereClause = 'WHERE ' + conditions.join(' AND ');

  return db.prepare(`
    SELECT
      dr.category,
      CASE dr.category
        WHEN 'orthopedic_implant' THEN '骨科植入物'
        WHEN 'cardiovascular' THEN '心血管'
        WHEN 'neurological' THEN '神经外科'
        WHEN 'interventional' THEN '介入类'
        WHEN 'ophthalmic' THEN '眼科'
        WHEN 'general_surgery' THEN '普外科'
        ELSE '其他'
      END as category_name,
      COALESCE(SUM(dr.usage_quantity), 0) as total_quantity,
      COALESCE(SUM(dr.usage_amount), 0) as total_amount,
      COUNT(DISTINCT dr.consumable_id) as consumable_count,
      COALESCE(AVG(dr.turnover_rate), 0) as avg_turnover
    FROM department_reports dr
    ${whereClause}
    GROUP BY dr.category
    ORDER BY total_amount DESC
  `).all(...values) as any[];
}

export async function exportReportToExcel(params: {
  startDate: string;
  endDate: string;
  departmentId?: number;
  category?: string;
  exportType?: 'detail' | 'category' | 'department';
}): Promise<{ success: boolean; message: string; filePath?: string }> {
  try {
    const exportType = params.exportType || 'detail';
    const db = getDatabase();
    const dateRange = `${params.startDate}_${params.endDate}`;

    if (exportType === 'category') {
      const categoryData = getCategorySummary(params);

      const columns: ExcelColumn[] = [
        { key: 'category_name', header: '耗材类别', width: 18 },
        { key: 'consumable_count', header: '耗材种类数', width: 14 },
        { key: 'total_quantity', header: '使用总量', width: 14 },
        { key: 'total_amount', header: '使用金额(元)', width: 16 },
        { key: 'avg_turnover', header: '平均周转率', width: 14 }
      ];

      const formattedData = categoryData.map(item => ({
        ...item,
        total_amount: item.total_amount.toFixed(2),
        avg_turnover: item.avg_turnover.toFixed(4)
      }));

      const filePath = await exportToExcel(
        formattedData,
        columns,
        `耗材类别统计报表_${dateRange}.xlsx`,
        '类别统计'
      );

      return { success: true, message: '导出成功', filePath };
    }

    if (exportType === 'department') {
      const conditions: string[] = ['dr.report_date >= ?', 'dr.report_date <= ?'];
      const values: any[] = [params.startDate, params.endDate];

      if (params.departmentId) {
        conditions.push('dr.department_id = ?');
        values.push(params.departmentId);
      }

      const whereClause = 'WHERE ' + conditions.join(' AND ');
      const deptData = db.prepare(`
        SELECT
          dr.department_id,
          dr.department_name,
          COUNT(DISTINCT dr.consumable_id) as consumable_count,
          COALESCE(SUM(dr.usage_quantity), 0) as total_quantity,
          COALESCE(SUM(dr.usage_amount), 0) as total_amount,
          COALESCE(AVG(dr.turnover_rate), 0) as avg_turnover
        FROM department_reports dr
        ${whereClause}
        GROUP BY dr.department_id
        ORDER BY total_amount DESC
      `).all(...values) as any[];

      const columns: ExcelColumn[] = [
        { key: 'department_name', header: '科室', width: 18 },
        { key: 'consumable_count', header: '耗材种类数', width: 14 },
        { key: 'total_quantity', header: '使用总量', width: 14 },
        { key: 'total_amount', header: '使用金额(元)', width: 16 },
        { key: 'avg_turnover', header: '平均周转率', width: 14 }
      ];

      const formattedData = deptData.map(item => ({
        ...item,
        total_amount: item.total_amount.toFixed(2),
        avg_turnover: item.avg_turnover.toFixed(4)
      }));

      const filePath = await exportToExcel(
        formattedData,
        columns,
        `科室统计报表_${dateRange}.xlsx`,
        '科室统计'
      );

      return { success: true, message: '导出成功', filePath };
    }

    const { list } = getDepartmentReports({ ...params, pageSize: 10000 });

    const columns: ExcelColumn[] = [
      { key: 'report_date', header: '统计日期', width: 14 },
      { key: 'department_name', header: '科室', width: 16 },
      { key: 'consumable_name', header: '耗材名称', width: 24 },
      { key: 'category', header: '类别', width: 14 },
      { key: 'usage_quantity', header: '使用量', width: 12 },
      { key: 'unit', header: '单位', width: 8 },
      { key: 'usage_amount', header: '使用金额(元)', width: 16 },
      { key: 'opening_stock', header: '期初库存', width: 12 },
      { key: 'closing_stock', header: '期末库存', width: 12 },
      { key: 'turnover_rate', header: '周转率', width: 12 }
    ];

    const formattedData = list.map(item => ({
      report_date: item.report_date,
      department_name: item.department_name,
      consumable_name: item.consumable_name,
      category: item.category,
      usage_quantity: item.usage_quantity,
      unit: item.unit,
      usage_amount: item.usage_amount.toFixed(2),
      opening_stock: item.opening_stock,
      closing_stock: item.closing_stock,
      turnover_rate: item.turnover_rate.toFixed(4)
    }));

    const filePath = await exportToExcel(
      formattedData,
      columns,
      `耗材使用明细报表_${dateRange}.xlsx`,
      '明细数据'
    );

    return { success: true, message: '导出成功', filePath };
  } catch (err: any) {
    return { success: false, message: `导出失败: ${err.message}` };
  }
}
