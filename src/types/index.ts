export enum ConsumableCategory {
  ORTHOPEDIC_IMPLANT = 'orthopedic_implant',
  CARDIOVASCULAR = 'cardiovascular',
  NEUROLOGICAL = 'neurological',
  INTERVENTIONAL = 'interventional',
  OPHTHALMIC = 'ophthalmic',
  GENERAL_SURGERY = 'general_surgery',
  OTHER = 'other'
}

export enum StorageRequirement {
  NORMAL = 'normal',
  REFRIGERATED = 'refrigerated',
  FROZEN = 'frozen',
  LIGHT_PROTECTED = 'light_protected',
  STERILE = 'sterile'
}

export enum CabinetStatus {
  AVAILABLE = 'available',
  OCCUPIED = 'occupied',
  PARTIAL = 'partial',
  MAINTENANCE = 'maintenance'
}

export enum SupplierQualificationStatus {
  VALID = 'valid',
  EXPIRED = 'expired',
  INVALID = 'invalid',
  PENDING = 'pending'
}

export enum StockInStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  COMPLETED = 'completed'
}

export enum RequisitionStatus {
  SUBMITTED = 'submitted',
  DEPARTMENT_APPROVED = 'department_approved',
  DEPARTMENT_REJECTED = 'department_rejected',
  QUANTITY_BLOCKED = 'quantity_blocked',
  QUANTITY_APPROVED = 'quantity_approved',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  STOCK_LOCKED = 'stock_locked',
  COMPLETED = 'completed'
}

export enum ConsumptionStatus {
  PENDING = 'pending',
  USED = 'used',
  PARTIAL = 'partial',
  RETURNED = 'returned'
}

export enum AlertType {
  EXPIRY_30 = 'expiry_30',
  EXPIRY_7 = 'expiry_7',
  EXPIRED = 'expired',
  LOW_STOCK = 'low_stock',
  SCRAPPED = 'scrapped'
}

export enum AlertStatus {
  ACTIVE = 'active',
  HANDLED = 'handled',
  IGNORED = 'ignored'
}

export interface Consumable {
  id: number;
  code: string;
  name: string;
  category: ConsumableCategory;
  specification: string;
  unit: string;
  price: number;
  storage_requirement: StorageRequirement;
  manufacturer: string;
  registration_cert_no: string;
  registration_cert_expiry: string;
  created_at: string;
  updated_at: string;
}

export interface Supplier {
  id: number;
  code: string;
  name: string;
  contact_person: string;
  contact_phone: string;
  business_license_no: string;
  business_license_expiry: string;
  medical_device_license_no: string;
  medical_device_license_expiry: string;
  qualification_status: SupplierQualificationStatus;
  created_at: string;
  updated_at: string;
}

export interface SmartCabinet {
  id: number;
  code: string;
  name: string;
  location: string;
  zone: string;
  supported_storage: StorageRequirement;
  total_slots: number;
  used_slots: number;
  status: CabinetStatus;
  created_at: string;
}

export interface CabinetSlot {
  id: number;
  cabinet_id: number;
  slot_code: string;
  layer: number;
  position: number;
  consumable_id: number | null;
  batch_no: string | null;
  quantity: number;
  status: 'empty' | 'occupied';
  locked: boolean;
}

export interface StockInRequest {
  id: number;
  request_no: string;
  supplier_id: number;
  consumable_id: number;
  batch_no: string;
  quantity: number;
  unit_price: number;
  production_date: string;
  expiry_date: string;
  status: StockInStatus;
  reject_reason: string | null;
  cabinet_id: number | null;
  slot_id: number | null;
  trace_code: string | null;
  auditor_id: number | null;
  created_by: number;
  created_at: string;
  audited_at: string | null;
  completed_at: string | null;
}

export interface Requisition {
  id: number;
  requisition_no: string;
  department_id: number;
  department_name: string;
  applicant_id: number;
  applicant_name: string;
  patient_id: string | null;
  patient_name: string | null;
  surgery_id: string | null;
  surgery_schedule_date: string | null;
  consumable_id: number;
  consumable_name: string;
  requested_quantity: number;
  estimated_quantity: number;
  historical_average: number;
  is_over_limit: boolean;
  over_limit_reason: string | null;
  split_suggestion: string | null;
  department_approver_id: number | null;
  department_approver_name: string | null;
  department_approved_at: string | null;
  final_approver_id: number | null;
  final_approver_name: string | null;
  final_approved_at: string | null;
  status: RequisitionStatus;
  reject_reason: string | null;
  locked_stock: number | null;
  created_at: string;
  updated_at: string;
}

export interface ConsumptionRecord {
  id: number;
  requisition_id: number | null;
  trace_code: string;
  consumable_id: number;
  cabinet_id: number;
  slot_id: number;
  quantity_used: number;
  quantity_remaining: number;
  patient_id: string | null;
  surgery_id: string | null;
  operator_id: number;
  operator_name: string;
  status: ConsumptionStatus;
  used_at: string;
  inventoried_at: string | null;
}

export interface Alert {
  id: number;
  type: AlertType;
  title: string;
  content: string;
  related_type: string | null;
  related_id: number | null;
  status: AlertStatus;
  notified_roles: string;
  created_at: string;
  handled_at: string | null;
}

export interface DisposalRecord {
  id: number;
  disposal_no: string;
  consumable_id: number;
  batch_no: string;
  quantity: number;
  reason: string;
  trace_codes: string;
  handler_id: number;
  handler_name: string;
  approver_id: number | null;
  approver_name: string | null;
  created_at: string;
}

export interface DepartmentReport {
  id: number;
  report_date: string;
  department_id: number;
  department_name: string;
  consumable_id: number;
  consumable_name: string;
  category: ConsumableCategory;
  usage_quantity: number;
  usage_amount: number;
  opening_stock: number;
  closing_stock: number;
  turnover_rate: number;
  created_at: string;
}
