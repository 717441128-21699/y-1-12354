import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { initializeDatabase } from './database/init';
import { startScheduledTasks } from './scheduler';
import { success, fail } from './utils/response';

import baseRoutes from './routes/base.routes';
import stockInRoutes from './routes/stock-in.routes';
import requisitionRoutes from './routes/requisition.routes';
import inventoryRoutes from './routes/inventory.routes';
import reportRoutes from './routes/report.routes';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req: Request, res: Response, next: NextFunction) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

app.use('/api/base', baseRoutes);
app.use('/api/stock-in', stockInRoutes);
app.use('/api/requisitions', requisitionRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/reports', reportRoutes);

app.get('/api/health', (req: Request, res: Response) => {
  res.json(success({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: '1.0.0'
  }));
});

app.get('/', (req: Request, res: Response) => {
  const endpoints = [
    { method: 'GET', path: '/api/health', desc: '系统健康检查' },
    { method: 'GET', path: '/api/base/consumables', desc: '耗材列表' },
    { method: 'GET', path: '/api/base/suppliers', desc: '供应商列表' },
    { method: 'GET', path: '/api/base/cabinets', desc: '智能柜列表' },
    { method: 'GET', path: '/api/base/inventory', desc: '库存汇总' },
    { method: 'POST', path: '/api/stock-in/requests', desc: '创建入库申请' },
    { method: 'POST', path: '/api/stock-in/requests/:id/audit', desc: '审核入库申请' },
    { method: 'GET', path: '/api/stock-in/requests', desc: '入库申请列表' },
    { method: 'POST', path: '/api/requisitions', desc: '创建领用申请' },
    { method: 'POST', path: '/api/requisitions/:id/approve-department', desc: '科室审核' },
    { method: 'POST', path: '/api/requisitions/:id/approve-final', desc: '最终审批&锁定库存' },
    { method: 'GET', path: '/api/requisitions', desc: '领用申请列表' },
    { method: 'POST', path: '/api/inventory/consumption', desc: '登记使用消耗' },
    { method: 'POST', path: '/api/inventory/cabinet/:id/inventory', desc: '智能柜自动盘点' },
    { method: 'POST', path: '/api/inventory/expiry/check', desc: '手动触发效期检查' },
    { method: 'POST', path: '/api/inventory/disposal', desc: '手动报废耗材' },
    { method: 'GET', path: '/api/inventory/alerts', desc: '预警列表' },
    { method: 'GET', path: '/api/inventory/notifications', desc: '通知列表' },
    { method: 'POST', path: '/api/reports/generate-daily', desc: '生成日报表' },
    { method: 'GET', path: '/api/reports/department', desc: '科室报表查询' },
    { method: 'GET', path: '/api/reports/category-summary', desc: '类别统计汇总' },
    { method: 'GET', path: '/api/reports/export', desc: '导出Excel报表' },
  ];

  res.json(success({
    name: '高值耗材智能管理系统 API',
    version: '1.0.0',
    description: '入库智能分配柜位 + 领用审批拦截 + 自动盘点报废 + 报表导出 + 实时通知',
    endpoints
  }));
});

app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('[API Error]', err);
  res.status(500).json(fail(err.message || '服务器内部错误', 500));
});

app.use((req: Request, res: Response) => {
  res.status(404).json(fail(`接口不存在: ${req.method} ${req.path}`, 404));
});

const exportsDir = path.join(__dirname, '../exports');
if (!fs.existsSync(exportsDir)) {
  fs.mkdirSync(exportsDir, { recursive: true });
}

function main() {
  console.log('========================================');
  console.log('  高值耗材智能管理系统 v1.0.0');
  console.log('========================================\n');

  console.log('[1/3] 初始化数据库...');
  initializeDatabase();
  console.log();

  console.log('[2/3] 启动定时任务调度器...');
  startScheduledTasks();
  console.log();

  app.listen(PORT, () => {
    console.log(`[3/3] API服务启动成功!`);
    console.log(`  本地访问: http://localhost:${PORT}`);
    console.log(`  健康检查: http://localhost:${PORT}/api/health`);
    console.log(`  API文档:   http://localhost:${PORT}/`);
    console.log('\n========================================\n');
  });
}

main();
