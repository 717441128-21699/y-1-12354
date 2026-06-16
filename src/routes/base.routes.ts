import { Router, Request, Response } from 'express';
import { getDatabase } from '../database/connection';
import { success, fail } from '../utils/response';
import { getInventorySummary, getInventoryByConsumable, getExpiringInventory } from '../services/cabinet.service';

const router = Router();

router.get('/consumables', (req: Request, res: Response) => {
  const db = getDatabase();
  const { keyword, category, page = 1, pageSize = 20 } = req.query;

  const conditions: string[] = [];
  const values: any[] = [];

  if (keyword) {
    conditions.push('(name LIKE ? OR code LIKE ? OR manufacturer LIKE ?)');
    values.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  if (category) {
    conditions.push('category = ?');
    values.push(category);
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const total = db.prepare(`SELECT COUNT(*) as count FROM consumables ${whereClause}`).get(...values) as { count: number };

  const list = db.prepare(`
    SELECT * FROM consumables
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(...values, Number(pageSize), (Number(page) - 1) * Number(pageSize));

  res.json(success({ list, total: total.count }));
});

router.get('/consumables/:id', (req: Request, res: Response) => {
  const db = getDatabase();
  const item = db.prepare('SELECT * FROM consumables WHERE id = ?').get(req.params.id);
  if (!item) {
    return res.json(fail('耗材不存在'));
  }
  res.json(success(item));
});

router.post('/consumables', (req: Request, res: Response) => {
  const db = getDatabase();
  const body = req.body;

  try {
    const result = db.prepare(`
      INSERT INTO consumables (
        code, name, category, specification, unit, price,
        storage_requirement, manufacturer, registration_cert_no,
        registration_cert_expiry, min_stock
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      body.code, body.name, body.category, body.specification || null,
      body.unit || '个', body.price || 0, body.storage_requirement || 'normal',
      body.manufacturer || null, body.registration_cert_no || null,
      body.registration_cert_expiry || null, body.min_stock || 0
    );

    res.json(success({ id: result.lastInsertRowid }, '耗材创建成功'));
  } catch (err: any) {
    res.json(fail(err.message));
  }
});

router.get('/suppliers', (req: Request, res: Response) => {
  const db = getDatabase();
  const { keyword, qualificationStatus, page = 1, pageSize = 20 } = req.query;

  const conditions: string[] = [];
  const values: any[] = [];

  if (keyword) {
    conditions.push('(name LIKE ? OR code LIKE ? OR contact_person LIKE ?)');
    values.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  if (qualificationStatus) {
    conditions.push('qualification_status = ?');
    values.push(qualificationStatus);
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const total = db.prepare(`SELECT COUNT(*) as count FROM suppliers ${whereClause}`).get(...values) as { count: number };

  const list = db.prepare(`
    SELECT * FROM suppliers
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(...values, Number(pageSize), (Number(page) - 1) * Number(pageSize));

  res.json(success({ list, total: total.count }));
});

router.get('/suppliers/:id', (req: Request, res: Response) => {
  const db = getDatabase();
  const item = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id);
  if (!item) return res.json(fail('供应商不存在'));
  res.json(success(item));
});

router.post('/suppliers', (req: Request, res: Response) => {
  const db = getDatabase();
  const body = req.body;

  try {
    const result = db.prepare(`
      INSERT INTO suppliers (
        code, name, contact_person, contact_phone,
        business_license_no, business_license_expiry,
        medical_device_license_no, medical_device_license_expiry,
        qualification_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      body.code, body.name, body.contact_person || null, body.contact_phone || null,
      body.business_license_no || null, body.business_license_expiry || null,
      body.medical_device_license_no || null, body.medical_device_license_expiry || null,
      body.qualification_status || 'pending'
    );

    res.json(success({ id: result.lastInsertRowid }, '供应商创建成功'));
  } catch (err: any) {
    res.json(fail(err.message));
  }
});

router.get('/cabinets', (req: Request, res: Response) => {
  const db = getDatabase();
  const list = db.prepare(`
    SELECT sc.*,
      (SELECT COUNT(*) FROM cabinet_slots WHERE cabinet_id = sc.id AND status = 'occupied') as occupied_count,
      (SELECT COUNT(*) FROM cabinet_slots WHERE cabinet_id = sc.id) as slot_count
    FROM smart_cabinets sc
    ORDER BY sc.code
  `).all();
  res.json(success(list));
});

router.get('/cabinets/:id/slots', (req: Request, res: Response) => {
  const db = getDatabase();
  const slots = db.prepare(`
    SELECT cs.*,
      c.name as consumable_name, c.code as consumable_code
    FROM cabinet_slots cs
    LEFT JOIN consumables c ON cs.consumable_id = c.id
    WHERE cs.cabinet_id = ?
    ORDER BY cs.layer, cs.position
  `).all(req.params.id);
  res.json(success(slots));
});

router.get('/inventory', (req: Request, res: Response) => {
  const summary = getInventorySummary();
  res.json(success(summary));
});

router.get('/inventory/consumable/:id', (req: Request, res: Response) => {
  const inventory = getInventoryByConsumable(Number(req.params.id));
  res.json(success(inventory));
});

router.get('/inventory/expiring', (req: Request, res: Response) => {
  const days = Number(req.query.days) || 30;
  const items = getExpiringInventory(days);
  res.json(success(items));
});

router.get('/departments', (req: Request, res: Response) => {
  const db = getDatabase();
  const list = db.prepare('SELECT * FROM departments ORDER BY code').all();
  res.json(success(list));
});

router.get('/users', (req: Request, res: Response) => {
  const db = getDatabase();
  const { role, departmentId } = req.query;

  const conditions: string[] = [];
  const values: any[] = [];

  if (role) {
    conditions.push('role = ?');
    values.push(role);
  }
  if (departmentId) {
    conditions.push('department_id = ?');
    values.push(departmentId);
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const list = db.prepare(`
    SELECT u.id, u.username, u.name, u.role, u.department_id, u.phone,
           d.name as department_name
    FROM users u
    LEFT JOIN departments d ON u.department_id = d.id
    ${whereClause}
    ORDER BY u.id
  `).all(...values);

  res.json(success(list));
});

export default router;
