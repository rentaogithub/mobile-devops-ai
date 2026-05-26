import fs from 'fs';
import { convertIPSToCrash } from './src/utils/ipsConverter';

const ipsContent = fs.readFileSync('../NNIM-2025-11-26-225828.ips', 'utf-8');
console.log('开始转换...');
console.log('文件大小:', ipsContent.length, '字节');
console.log('');

try {
  const result = convertIPSToCrash(ipsContent);
  console.log('✅ 转换成功!');
  console.log('输出大小:', result.length, '字节');
  console.log('');
  console.log('输出预览（前 1000 字符）:');
  console.log('---');
  console.log(result.substring(0, 1000));
  console.log('---');
  console.log('');
  console.log('检查关键内容:');
  console.log('  包含 "Thread 0 Crashed:":', result.includes('Thread 0 Crashed:'));
  console.log('  包含 "Binary Images:":', result.includes('Binary Images:'));
} catch (error: any) {
  console.error('❌ 转换失败:', error.message);
  console.error(error.stack);
}
