import cron from 'node-cron';
import { generateDailyReport } from '../services/report.service';
import { checkAndHandleExpiry } from '../services/expiry.service';
import { formatDate } from '../utils/date';

export function startScheduledTasks(): void {
  console.log('[定时任务] 调度器启动中...');

  cron.schedule('0 0 2 * * *', () => {
    console.log(`[定时任务][${formatDate(new Date())}] 开始执行每日报表生成...`);
    try {
      const result = generateDailyReport();
      console.log(`[定时任务] 每日报表生成完成：${result.message}`);
    } catch (err) {
      console.error('[定时任务] 每日报表生成失败:', err);
    }
  }, {
    scheduled: true,
    timezone: 'Asia/Shanghai'
  });
  console.log('[定时任务] 每日凌晨2:00报表生成任务已注册');

  cron.schedule('0 0 3 * * *', () => {
    console.log(`[定时任务][${formatDate(new Date())}] 开始执行效期检查...`);
    try {
      const result = checkAndHandleExpiry();
      console.log(`[定时任务] 效期检查完成：预警${result.alertsCreated}条，锁定${result.itemsLocked}项，报废${result.itemsScrapped}项`);
    } catch (err) {
      console.error('[定时任务] 效期检查失败:', err);
    }
  }, {
    scheduled: true,
    timezone: 'Asia/Shanghai'
  });
  console.log('[定时任务] 每日凌晨3:00效期检查任务已注册');

  cron.schedule('0 */6 * * *', () => {
    console.log(`[定时任务][${formatDate(new Date())}] 执行每6小时临时效期检查...`);
    try {
      const result = checkAndHandleExpiry();
      if (result.alertsCreated > 0 || result.itemsScrapped > 0) {
        console.log(`[定时任务] 临时检查发现：预警${result.alertsCreated}条，锁定${result.itemsLocked}项，报废${result.itemsScrapped}项`);
      }
    } catch (err) {
      console.error('[定时任务] 临时效期检查失败:', err);
    }
  }, {
    scheduled: true,
    timezone: 'Asia/Shanghai'
  });
  console.log('[定时任务] 每6小时效期巡检任务已注册');

  console.log('[定时任务] 所有调度任务启动完成!');
}
