import { getDatabase } from './connection';
import fs from 'fs';
import path from 'path';

const createTablesSQL = `
CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  manager_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password TEXT NOT NULL,
  role TEXT NOT NULL,
  department_id INTEGER,
  phone TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  FOREIGN KEY (department_id) REFERENCES departments(id)
);

CREATE TABLE IF NOT EXISTS consumables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  specification TEXT,
  unit TEXT NOT NULL DEFAULT '个',
  price REAL NOT NULL DEFAULT 0,
  storage_requirement TEXT NOT NULL DEFAULT 'normal',
  manufacturer TEXT,
  registration_cert_no TEXT,
  registration_cert_expiry TEXT,
  min_stock INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  contact_person TEXT,
  contact_phone TEXT,
  business_license_no TEXT,
  business_license_expiry TEXT,
  medical_device_license_no TEXT,
  medical_device_license_expiry TEXT,
  qualification_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS smart_cabinets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  location TEXT,
  zone TEXT,
  supported_storage TEXT NOT NULL DEFAULT 'normal',
  total_slots INTEGER NOT NULL DEFAULT 0,
  used_slots INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'available',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS cabinet_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cabinet_id INTEGER NOT NULL,
  slot_code TEXT NOT NULL,
  layer INTEGER NOT NULL,
  position INTEGER NOT NULL,
  consumable_id INTEGER,
  batch_no TEXT,
  quantity INTEGER NOT NULL DEFAULT 0,
  expiry_date TEXT,
  status TEXT NOT NULL DEFAULT 'empty',
  locked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  FOREIGN KEY (cabinet_id) REFERENCES smart_cabinets(id),
  FOREIGN KEY (consumable_id) REFERENCES consumables(id),
  UNIQUE(cabinet_id, slot_code)
);

CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  consumable_id INTEGER NOT NULL,
  cabinet_id INTEGER NOT NULL,
  slot_id INTEGER NOT NULL,
  supplier_id INTEGER,
  batch_no TEXT NOT NULL,
  trace_code TEXT UNIQUE NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  production_date TEXT,
  expiry_date TEXT,
  unit_price REAL NOT NULL DEFAULT 0,
  locked_quantity INTEGER NOT NULL DEFAULT 0,
  stock_in_id INTEGER,
  status TEXT NOT NULL DEFAULT 'normal',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS stock_in_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_no TEXT UNIQUE NOT NULL,
  supplier_id INTEGER NOT NULL,
  consumable_id INTEGER NOT NULL,
  batch_no TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price REAL NOT NULL DEFAULT 0,
  production_date TEXT,
  expiry_date TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  reject_reason TEXT,
  cabinet_id INTEGER,
  slot_id INTEGER,
  trace_code TEXT,
  auditor_id INTEGER,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  audited_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  FOREIGN KEY (consumable_id) REFERENCES consumables(id),
  FOREIGN KEY (cabinet_id) REFERENCES smart_cabinets(id),
  FOREIGN KEY (slot_id) REFERENCES cabinet_slots(id)
);

CREATE TABLE IF NOT EXISTS requisitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requisition_no TEXT UNIQUE NOT NULL,
  department_id INTEGER NOT NULL,
  department_name TEXT,
  applicant_id INTEGER NOT NULL,
  applicant_name TEXT,
  patient_id TEXT,
  patient_name TEXT,
  patient_history TEXT,
  surgery_id TEXT,
  surgery_schedule_date TEXT,
  consumable_id INTEGER NOT NULL,
  consumable_name TEXT,
  requested_quantity INTEGER NOT NULL,
  estimated_quantity INTEGER,
  historical_average REAL,
  is_over_limit INTEGER NOT NULL DEFAULT 0,
  over_limit_reason TEXT,
  split_suggestion TEXT,
  department_approver_id INTEGER,
  department_approver_name TEXT,
  department_approved_at TEXT,
  department_comment TEXT,
  final_approver_id INTEGER,
  final_approver_name TEXT,
  final_approved_at TEXT,
  final_comment TEXT,
  status TEXT NOT NULL DEFAULT 'submitted',
  reject_reason TEXT,
  locked_stock INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS consumption_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requisition_id INTEGER,
  trace_code TEXT NOT NULL,
  consumable_id INTEGER NOT NULL,
  cabinet_id INTEGER NOT NULL,
  slot_id INTEGER NOT NULL,
  quantity_used INTEGER NOT NULL,
  quantity_remaining INTEGER NOT NULL DEFAULT 0,
  patient_id TEXT,
  surgery_id TEXT,
  operator_id INTEGER NOT NULL,
  operator_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  used_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  inventoried_at TEXT,
  FOREIGN KEY (requisition_id) REFERENCES requisitions(id)
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  related_type TEXT,
  related_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  notified_roles TEXT NOT NULL DEFAULT 'warehouse_manager,operating_room_nurse',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  handled_at TEXT
);

CREATE TABLE IF NOT EXISTS disposal_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  disposal_no TEXT UNIQUE NOT NULL,
  consumable_id INTEGER NOT NULL,
  batch_no TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  reason TEXT NOT NULL,
  trace_codes TEXT NOT NULL,
  handler_id INTEGER NOT NULL,
  handler_name TEXT,
  approver_id INTEGER,
  approver_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS department_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_date TEXT NOT NULL,
  department_id INTEGER NOT NULL,
  department_name TEXT,
  consumable_id INTEGER NOT NULL,
  consumable_name TEXT,
  category TEXT,
  usage_quantity INTEGER NOT NULL DEFAULT 0,
  usage_amount REAL NOT NULL DEFAULT 0,
  opening_stock INTEGER NOT NULL DEFAULT 0,
  closing_stock INTEGER NOT NULL DEFAULT 0,
  turnover_rate REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE(report_date, department_id, consumable_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  related_type TEXT,
  related_id INTEGER,
  recipient_roles TEXT NOT NULL,
  read_status TEXT NOT NULL DEFAULT 'unread',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS requisition_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requisition_id INTEGER NOT NULL,
  consumable_id INTEGER NOT NULL,
  consumable_name TEXT,
  requested_quantity INTEGER NOT NULL,
  allocated_quantity INTEGER NOT NULL DEFAULT 0,
  historical_average REAL,
  estimated_quantity INTEGER,
  is_over_limit INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (requisition_id) REFERENCES requisitions(id)
);

CREATE INDEX IF NOT EXISTS idx_inventory_consumable ON inventory(consumable_id);
CREATE INDEX IF NOT EXISTS idx_inventory_trace ON inventory(trace_code);
CREATE INDEX IF NOT EXISTS idx_inventory_expiry ON inventory(expiry_date);
CREATE INDEX IF NOT EXISTS idx_requisitions_status ON requisitions(status);
CREATE INDEX IF NOT EXISTS idx_requisitions_department ON requisitions(department_id);
CREATE INDEX IF NOT EXISTS idx_consumption_date ON consumption_records(used_at);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
CREATE INDEX IF NOT EXISTS idx_reports_date ON department_reports(report_date);
`;

const seedDataSQL = `
INSERT INTO departments (code, name) VALUES
('DEPT001', '骨科'),
('DEPT002', '心血管外科'),
('DEPT003', '神经外科'),
('DEPT004', '普外科'),
('DEPT005', '眼科'),
('DEPT006', '介入科');

INSERT INTO users (username, name, password, role, department_id, phone) VALUES
('admin', '系统管理员', 'admin123', 'admin', NULL, '13800000000'),
('warehouse_mgr', '库房管理员', '123456', 'warehouse_manager', NULL, '13800000001'),
('or_nurse', '手术室护士', '123456', 'operating_room_nurse', NULL, '13800000002'),
('dept_head1', '骨科主任', '123456', 'department_head', 1, '13800000003'),
('doctor1', '张医生', '123456', 'doctor', 1, '13800000004'),
('doctor2', '李医生', '123456', 'doctor', 2, '13800000005');

INSERT INTO consumables (code, name, category, specification, unit, price, storage_requirement, manufacturer, registration_cert_no, registration_cert_expiry, min_stock) VALUES
('CONS001', '人工髋关节假体', 'orthopedic_implant', '标准型', '套', 25000, 'normal', '某医疗器械公司', '国械注准20233130001', '2028-12-31', 5),
('CONS002', '人工膝关节假体', 'orthopedic_implant', '旋转平台型', '套', 32000, 'normal', '某医疗器械公司', '国械注准20233130002', '2028-06-30', 3),
('CONS003', '心脏支架', 'cardiovascular', '药物洗脱支架3.0*18mm', '根', 18000, 'sterile', '某心血管器械公司', '国械注准20233130003', '2027-09-30', 10),
('CONS004', '人工晶状体', 'ophthalmic', '单焦点人工晶体', '片', 8500, 'light_protected', '某眼科器械公司', '国械注准20233160004', '2029-03-31', 15),
('CONS005', '颅内动脉瘤夹', 'neurological', '标准动脉瘤夹', '个', 12000, 'sterile', '某神经外科器械公司', '国械注准20233130005', '2028-01-31', 8),
('CONS006', '球囊扩张导管', 'interventional', '快速交换球囊导管', '根', 6500, 'sterile', '某介入器械公司', '国械注准20233030006', '2027-12-31', 12),
('CONS007', '一次性直线切割吻合器', 'general_surgery', '60mm钉仓', '把', 3800, 'normal', '某外科器械公司', '国械注准20233020007', '2026-12-31', 20);

INSERT INTO suppliers (code, name, contact_person, contact_phone, business_license_no, business_license_expiry, medical_device_license_no, medical_device_license_expiry, qualification_status) VALUES
('SUP001', '华康医疗器械有限公司', '王经理', '13900000001', '91310000MA1FL001', '2030-12-31', '沪食药监械经营许20230001号', '2028-12-31', 'valid'),
('SUP002', '仁心医疗科技股份公司', '李经理', '13900000002', '91310000MA1FL002', '2029-06-30', '沪食药监械经营许20230002号', '2027-06-30', 'valid'),
('SUP003', '博信医疗设备公司', '赵经理', '13900000003', '91310000MA1FL003', '2025-03-31', '沪食药监械经营许20230003号', '2025-03-31', 'expired');

INSERT INTO smart_cabinets (code, name, location, zone, supported_storage, total_slots, used_slots, status) VALUES
('CAB001', '骨科耗材柜A', '手术室耗材室1区', '1区', 'normal', 24, 0, 'available'),
('CAB002', '心血管耗材柜B', '手术室耗材室1区', '1区', 'sterile', 30, 0, 'available'),
('CAB003', '神经外科耗材柜', '手术室耗材室2区', '2区', 'sterile', 20, 0, 'available'),
('CAB004', '眼科低温存储柜', '手术室耗材室冷藏区', '冷藏区', 'refrigerated', 16, 0, 'available'),
('CAB005', '避光耗材柜', '手术室耗材室2区', '2区', 'light_protected', 18, 0, 'available'),
('CAB006', '介入耗材柜', '介入手术室', '介入区', 'sterile', 24, 0, 'available');
`;

function generateCabinetSlots(): string {
  const cabinets = [
    { id: 1, total: 24, layers: 4 },
    { id: 2, total: 30, layers: 5 },
    { id: 3, total: 20, layers: 4 },
    { id: 4, total: 16, layers: 4 },
    { id: 5, total: 18, layers: 3 },
    { id: 6, total: 24, layers: 4 }
  ];

  let sql = '';
  cabinets.forEach(cab => {
    const perLayer = Math.floor(cab.total / cab.layers);
    for (let layer = 1; layer <= cab.layers; layer++) {
      for (let pos = 1; pos <= perLayer; pos++) {
        const slotCode = `CAB${String(cab.id).padStart(3, '0')}-L${layer}-P${String(pos).padStart(2, '0')}`;
        sql += `INSERT INTO cabinet_slots (cabinet_id, slot_code, layer, position, status, locked) VALUES (${cab.id}, '${slotCode}', ${layer}, ${pos}, 'empty', 0);\n`;
      }
    }
  });
  return sql;
}

export function initializeDatabase(): void {
  const dataDir = path.join(__dirname, '../../data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const db = getDatabase();

  console.log('开始创建数据表...');
  db.exec(createTablesSQL);
  console.log('数据表创建完成!');

  const deptCount = db.prepare('SELECT COUNT(*) as count FROM departments').get() as { count: number };
  if (deptCount.count === 0) {
    console.log('开始插入初始化数据...');
    const insert = db.transaction(() => {
      db.exec(seedDataSQL);
      db.exec(generateCabinetSlots());
    });
    insert();
    console.log('初始化数据插入完成!');
  } else {
    console.log('数据库已存在初始化数据，跳过初始化。');
  }

  console.log('数据库初始化完成!');
}

if (require.main === module) {
  initializeDatabase();
  process.exit(0);
}
