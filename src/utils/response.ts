export interface ApiResponse<T = any> {
  success: boolean;
  code: number;
  message: string;
  data?: T;
  timestamp: number;
}

export function success<T>(data?: T, message: string = '操作成功'): ApiResponse<T> {
  return {
    success: true,
    code: 200,
    message,
    data,
    timestamp: Date.now()
  };
}

export function fail(message: string, code: number = 400, data?: any): ApiResponse {
  return {
    success: false,
    code,
    message,
    data,
    timestamp: Date.now()
  };
}
