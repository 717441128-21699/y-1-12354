import { v4 as uuidv4 } from 'uuid';
import CryptoJS from 'crypto-js';

export interface TraceCodeInfo {
  traceCode: string;
  consumableCode: string;
  batchNo: string;
  timestamp: number;
}

export function generateTraceCode(
  consumableCode: string,
  batchNo: string,
  supplierCode: string,
  cabinetCode: string,
  slotCode: string
): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();

  const rawData = `${consumableCode}-${batchNo}-${supplierCode}-${cabinetCode}-${slotCode}-${timestamp}-${random}`;
  const hash = CryptoJS.MD5(rawData).toString().substring(0, 8).toUpperCase();

  const datePart = new Date(timestamp).toISOString().slice(2, 10).replace(/-/g, '');

  const traceCode = `HV-${datePart}-${consumableCode.substring(0, 4)}-${batchNo.substring(0, 4)}-${hash}-${random}`;

  return traceCode;
}

export function generateRequestNo(prefix: string = 'SI'): string {
  const date = new Date();
  const datePart = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  const timePart = `${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}`;
  const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `${prefix}${datePart}${timePart}${random}`;
}

export function generateRequisitionNo(): string {
  return generateRequestNo('RQ');
}

export function generateDisposalNo(): string {
  return generateRequestNo('DP');
}

export function parseTraceCode(traceCode: string): { valid: boolean; info?: Partial<TraceCodeInfo> } {
  const pattern = /^HV-\d{6}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{8}-[A-Z0-9]{6}$/;
  return {
    valid: pattern.test(traceCode)
  };
}

export function generateUUID(): string {
  return uuidv4();
}
