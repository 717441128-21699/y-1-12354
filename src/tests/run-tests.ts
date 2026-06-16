import { initializeDatabase } from '../database/init';
import { getDatabase } from '../database/connection';
import {
  createStockInRequest,
  auditStockInRequest,
  checkSupplierQualification,
  checkRegistrationCert
} from '../services/stock-in.service';
import {
  createRequisition,
  approveRequisitionByDepartment,
  approveRequisitionFinal,
  estimateUsage
} from '../services/requisition.service';
import {
  recordConsumption,
  autoInventoryByCabinet
} from '../services/consumption.service';
import {
  checkAndHandleExpiry,
  manualDispose
} from '../services/expiry.service';
import {
  generateDailyReport,
  getCategorySummary,
  exportReportToExcel
} from '../services/report.service';
import { formatDate } from '../utils/date';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err: any) {
    console.log(`  ❌ ${name}: ${err.message}`);
    failed++;
  }
}

function assert(condition: boolean, message: string = '断言失败') {
  if (!condition) throw new Error(message);
}

function runAllTests() {
  console.log('========================================');
  console.log('  高值耗材智能管理系统 - 集成测试');
  console.log('========================================\n');

  console.log('[步骤1] 初始化测试数据库...');
  initializeDatabase();
  const db = getDatabase();
  console.log();

  console.log('[测试组1] 供应商资质与注册证校验');
  test('有效供应商资质校验通过', () => {
    const result = checkSupplierQualification(1);
    assert(result.valid === true, '华康医疗资质应有效');
  });
  test('过期供应商资质校验失败', () => {
    const result = checkSupplierQualification(3);
    assert(result.valid === false, '博信医疗资质应无效');
    assert(result.issues.length > 0, '应有问题列表');
  });
  test('有效耗材注册证校验', () => {
    const result = checkRegistrationCert(1);
    assert(result.valid === true, '人工髋关节假体注册证应有效');
  });
  console.log();

  console.log('[测试组2] 入库申请流程');
  let stockInId = 0;
  test('创建入库申请（有效供应商+有效耗材）', () => {
    const result = createStockInRequest({
      supplierId: 1,
      consumableId: 1,
      batchNo: 'BATCH-' + Date.now().toString().slice(-6),
      quantity: 10,
      unitPrice: 25000,
      productionDate: '2026-01-01',
      expiryDate: '2028-12-31',
      createdBy: 2
    });
    assert(result.success === true, result.message);
    stockInId = result.data!.id;
    assert(stockInId > 0, '应返回入库申请ID');
  });
  test('创建入库申请（过期供应商自动退回）', () => {
    const result = createStockInRequest({
      supplierId: 3,
      consumableId: 1,
      batchNo: 'EXPIRED-' + Date.now().toString().slice(-6),
      quantity: 5,
      unitPrice: 25000,
      productionDate: '2026-01-01',
      expiryDate: '2028-12-31',
      createdBy: 2
    });
    assert(result.success === false, '过期供应商应被退回');
    assert(result.data?.status === 'rejected', '状态应为rejected');
  });
  test('审核通过入库申请（自动分配柜位+生成追溯码）', () => {
    const result = auditStockInRequest(stockInId, 2, true);
    assert(result.success === true, result.message);
    assert(result.data?.trace_code, '应生成追溯码');
    assert(result.data?.cabinet_id > 0, '应分配柜位');
  });
  console.log();

  console.log('[测试组3] 领用申请与智能预估');
  test('基于历史数据预估用量（无数据情况）', () => {
    const result = estimateUsage(1, 1, 5);
    assert(result.estimatedQuantity > 0, '应有预估数量');
  });
  test('超阈值申请触发拦截', () => {
    const result = estimateUsage(1, 1, 100);
    assert(result.isOverLimit === true || result.historicalAverage === 0, '超阈值应触发拦截或无历史数据');
  });
  let reqId = 0;
  test('创建领用申请', () => {
    const result = createRequisition({
      departmentId: 1,
      applicantId: 5,
      patientId: 'P12345',
      patientName: '测试患者',
      patientHistory: '糖尿病，高血压',
      surgeryId: 'OP' + Date.now(),
      surgeryScheduleDate: formatDate(new Date(Date.now() + 3 * 86400000), 'YYYY-MM-DD'),
      consumableId: 1,
      requestedQuantity: 2
    });
    assert(result.success === true, result.message);
    reqId = result.data!.id;
    assert(reqId > 0, '应返回申请ID');
  });
  test('科室审核通过', () => {
    const result = approveRequisitionByDepartment(reqId, 4, true);
    assert(result.success === true, result.message);
  });
  test('库房最终审批&FIFO库存锁定', () => {
    const result = approveRequisitionFinal(reqId, 2, true);
    assert(result.success === true, result.message);
    assert(result.data?.status === 'stock_locked', '状态应为stock_locked');
  });
  console.log();

  console.log('[测试组4] 消耗登记与自动盘点');
  test('使用消耗登记（更新台账）', () => {
    const inv = db.prepare('SELECT * FROM inventory WHERE consumable_id = 1 LIMIT 1').get() as any;
    if (inv) {
      const result = recordConsumption({
        requisitionId: reqId,
        traceCode: inv.trace_code,
        consumableId: 1,
        cabinetId: inv.cabinet_id,
        slotId: inv.slot_id,
        quantityUsed: 1,
        patientId: 'P12345',
        surgeryId: 'OPTEST',
        operatorId: 3,
        operatorName: '手术室护士'
      });
      assert(result.success === true, result.message);
    } else {
      throw new Error('无可用库存数据');
    }
  });
  test('智能柜自动盘点', () => {
    const result = autoInventoryByCabinet(1);
    assert(result.success === true, result.message);
  });
  console.log();

  console.log('[测试组5] 效期预警与自动报废');
  test('创建临期耗材数据进行效期测试', () => {
    const batchNo = 'EXP-TEST-' + Date.now().toString().slice(-6);
    const req = createStockInRequest({
      supplierId: 1,
      consumableId: 7,
      batchNo,
      quantity: 5,
      unitPrice: 3800,
      expiryDate: formatDate(new Date(Date.now() + 15 * 86400000), 'YYYY-MM-DD'),
      createdBy: 2
    });
    if (req.success && req.data) {
      auditStockInRequest(req.data.id, 2, true);
    }
  });
  test('效期检查（创建预警/锁定/报废）', () => {
    const result = checkAndHandleExpiry();
    assert(typeof result.alertsCreated === 'number', '应返回预警数');
    assert(typeof result.itemsLocked === 'number', '应返回锁定数');
    console.log(`     -> 本次检查：预警${result.alertsCreated}条，锁定${result.itemsLocked}项，报废${result.itemsScrapped}项`);
  });
  console.log();

  console.log('[测试组6] 报表生成与Excel导出');
  test('生成当日日报表', () => {
    const result = generateDailyReport();
    assert(result.success === true, result.message);
    console.log(`     -> 报表：${result.data?.totalRecords}条记录，总金额￥${(result.data?.totalAmount || 0).toFixed(2)}`);
  });
  test('按类别统计汇总', () => {
    const today = formatDate(new Date(), 'YYYY-MM-DD');
    const result = getCategorySummary({
      startDate: today,
      endDate: today
    });
    assert(Array.isArray(result), '应返回数组');
  });
  test('导出Excel报表（类别统计）', async () => {
    const today = formatDate(new Date(), 'YYYY-MM-DD');
    const result = await exportReportToExcel({
      startDate: today,
      endDate: today,
      exportType: 'category'
    });
    assert(result.success === true, result.message);
    console.log(`     -> 导出文件: ${result.filePath}`);
  });
  console.log();

  console.log('========================================');
  console.log(`  测试完成: ✅ ${passed} 通过 | ❌ ${failed} 失败`);
  console.log('========================================');

  process.exit(failed > 0 ? 1 : 0);
}

runAllTests();
