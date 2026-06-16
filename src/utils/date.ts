import dayjs from 'dayjs';

export const formatDate = (date: Date | string | number, format: string = 'YYYY-MM-DD HH:mm:ss'): string => {
  return dayjs(date).format(format);
};

export const daysBetween = (date1: Date | string, date2: Date | string): number => {
  return dayjs(date1).diff(dayjs(date2), 'day');
};

export const addDays = (date: Date | string, days: number): Date => {
  return dayjs(date).add(days, 'day').toDate();
};

export const isExpired = (expiryDate: Date | string): boolean => {
  return dayjs().isAfter(dayjs(expiryDate), 'day');
};

export const daysUntilExpiry = (expiryDate: Date | string): number => {
  return dayjs(expiryDate).diff(dayjs(), 'day');
};
