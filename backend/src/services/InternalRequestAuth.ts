import { randomBytes } from 'crypto';

// 仅用于同一后端进程向自身发起的产品线后台同步请求，不写入磁盘或响应给客户端。
export const internalRequestToken = randomBytes(32).toString('hex');
