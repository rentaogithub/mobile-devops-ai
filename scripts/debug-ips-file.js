#!/usr/bin/env node

/**
 * 调试 .ips 文件处理
 * 用法: node scripts/debug-ips-file.js <path-to-ips-file>
 */

const fs = require('fs');
const path = require('path');

// 检查参数
if (process.argv.length < 3) {
  console.log('用法: node scripts/debug-ips-file.js <path-to-ips-file>');
  console.log('示例: node scripts/debug-ips-file.js crash.ips');
  process.exit(1);
}

const ipsFilePath = process.argv[2];

console.log('====================================');
console.log('调试 .ips 文件处理');
console.log('====================================\n');

// 读取文件
console.log(`读取文件: ${ipsFilePath}`);
if (!fs.existsSync(ipsFilePath)) {
  console.error(`❌ 文件不存在: ${ipsFilePath}`);
  process.exit(1);
}

const ipsContent = fs.readFileSync(ipsFilePath, 'utf-8');
console.log(`✅ 文件读取成功`);
console.log(`   文件大小: ${ipsContent.length} 字节`);
console.log(`   行数: ${ipsContent.split('\n').length}`);
console.log('');

// 检测格式
console.log('检测格式...');
const trimmed = ipsContent.trim();
const startsWithBrace = trimmed.startsWith('{');
const hasThreadCrashed = ipsContent.includes('Thread 0 Crashed:');
const hasBinaryImages = ipsContent.includes('Binary Images:');
const hasStackFormat = /^\d+\s+\S+\s+0x[0-9a-f]+/.test(ipsContent);

console.log(`   以 { 开头: ${startsWithBrace}`);
console.log(`   包含 "Thread 0 Crashed:": ${hasThreadCrashed}`);
console.log(`   包含 "Binary Images:": ${hasBinaryImages}`);
console.log(`   包含堆栈格式: ${hasStackFormat}`);

const isTextFormat = hasThreadCrashed || hasBinaryImages || hasStackFormat;
const isIPSFormat = startsWithBrace && !isTextFormat;
console.log(`   判断为文本格式: ${isTextFormat}`);
console.log(`   判断为 .ips JSON 格式: ${isIPSFormat}`);
console.log('');

if (!isIPSFormat) {
  console.log('⚠️  文件不是 .ips JSON 格式，可能已经是文本格式');
  console.log('');
  console.log('文件内容预览（前 500 字符）:');
  console.log('---');
  console.log(ipsContent.substring(0, 500));
  console.log('---');
  process.exit(0);
}

// 尝试解析
console.log('尝试解析 JSON...');

let crashData = null;
let headerData = null;

try {
  // 尝试单个 JSON
  console.log('  方法1: 解析为单个 JSON...');
  crashData = JSON.parse(ipsContent);
  console.log('  ✅ 成功解析为单个 JSON');
  console.log(`     字段: ${Object.keys(crashData).join(', ')}`);
  console.log(`     threads: ${!!crashData.threads}`);
  console.log(`     binaryImages: ${!!crashData.binaryImages}`);
} catch (firstError) {
  console.log(`  ❌ 单个 JSON 解析失败: ${firstError.message}`);
  console.log('');
  
  // 多行 JSON
  console.log('  方法2: 解析为多行 JSON...');
  const lines = ipsContent.trim().split('\n');
  console.log(`     找到 ${lines.length} 行`);
  console.log('');
  
  // 分析每一行
  console.log('  分析每一行:');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    console.log(`     第 ${i + 1} 行:`);
    
    if (!line) {
      console.log(`       - 空行`);
      continue;
    }
    
    if (!line.startsWith('{')) {
      console.log(`       - 不是 JSON（前10字符: ${line.substring(0, 10)}）`);
      continue;
    }
    
    try {
      const data = JSON.parse(line);
      const keys = Object.keys(data);
      console.log(`       - JSON 解析成功`);
      console.log(`       - 字段数: ${keys.length}`);
      console.log(`       - 关键字段:`);
      console.log(`         * app_name: ${!!data.app_name}`);
      console.log(`         * timestamp: ${!!data.timestamp}`);
      console.log(`         * incident_id: ${!!data.incident_id}`);
      console.log(`         * threads: ${!!data.threads}`);
      console.log(`         * binaryImages: ${!!data.binaryImages}`);
      
      // 判断是头部还是堆栈数据
      if (data.threads && data.binaryImages) {
        console.log(`       - ✅ 这是堆栈数据`);
        if (!crashData) {
          crashData = data;
          console.log(`       - 已保存为 crashData`);
        }
      } else if (data.app_name || data.timestamp || data.incident_id) {
        console.log(`       - ✅ 这是头部信息`);
        if (!headerData) {
          headerData = data;
          console.log(`       - 已保存为 headerData`);
        }
      } else {
        console.log(`       - ⚠️  未知类型的数据`);
      }
    } catch (e) {
      console.log(`       - ❌ JSON 解析失败: ${e.message}`);
      console.log(`       - 内容预览: ${line.substring(0, 50)}...`);
    }
    console.log('');
  }
  
  // 合并数据
  if (crashData && headerData) {
    console.log('  合并头部信息和堆栈数据...');
    crashData = {
      ...headerData,
      ...crashData,
      threads: crashData.threads,
      binaryImages: crashData.binaryImages,
    };
    console.log('  ✅ 合并成功');
  }
}

console.log('');
console.log('====================================');
console.log('解析结果');
console.log('====================================\n');

if (!crashData) {
  console.log('❌ 解析失败：未找到有效的崩溃数据');
  process.exit(1);
}

if (!crashData.threads || !crashData.binaryImages) {
  console.log('❌ 数据不完整：');
  console.log(`   threads: ${!!crashData.threads}`);
  console.log(`   binaryImages: ${!!crashData.binaryImages}`);
  process.exit(1);
}

console.log('✅ 解析成功\n');

console.log('应用信息:');
console.log(`   app_name: ${crashData.app_name || 'N/A'}`);
console.log(`   app_version: ${crashData.app_version || 'N/A'}`);
console.log(`   bundleID: ${crashData.bundleID || 'N/A'}`);
console.log(`   timestamp: ${crashData.timestamp || 'N/A'}`);
console.log(`   incident_id: ${crashData.incident_id || 'N/A'}`);
console.log('');

console.log('崩溃数据:');
console.log(`   threads: ${crashData.threads.length} 个`);
console.log(`   binaryImages: ${crashData.binaryImages.length} 个`);
console.log('');

const crashedThread = crashData.threads.find(t => t.triggered) || crashData.threads[0];
console.log('崩溃线程:');
console.log(`   triggered: ${crashedThread.triggered || false}`);
console.log(`   frames: ${crashedThread.frames ? crashedThread.frames.length : 0} 个`);
console.log('');

if (crashData.binaryImages.length > 0) {
  const mainImage = crashData.binaryImages[0];
  console.log('主二进制:');
  console.log(`   name: ${mainImage.name || 'N/A'}`);
  console.log(`   uuid: ${mainImage.uuid || 'N/A'}`);
  console.log(`   arch: ${mainImage.arch || 'N/A'}`);
  console.log('');
}

console.log('✅ 数据完整，可以进行转换和符号化');
console.log('');

// 尝试转换
console.log('====================================');
console.log('尝试转换为文本格式');
console.log('====================================\n');

try {
  // 动态加载转换函数
  const converterPath = path.join(__dirname, '../backend/src/utils/ipsConverter.ts');
  console.log(`加载转换器: ${converterPath}`);
  
  // 由于是 TypeScript，我们需要使用 ts-node 或者直接测试逻辑
  console.log('⚠️  需要在 TypeScript 环境中运行转换');
  console.log('   建议：在后端代码中添加日志来调试');
  console.log('');
  console.log('或者运行：');
  console.log(`   cd backend && npx ts-node -e "const {convertIPSToCrash} = require('./src/utils/ipsConverter'); console.log(convertIPSToCrash(require('fs').readFileSync('${ipsFilePath}', 'utf-8')))"`);
} catch (error) {
  console.error(`❌ 转换失败: ${error.message}`);
}

console.log('');
