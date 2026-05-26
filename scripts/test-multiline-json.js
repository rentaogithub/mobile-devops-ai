#!/usr/bin/env node

/**
 * 测试多行 JSON 解析
 * 用于验证 .ips 文件的两段 JSON 格式是否能正确解析
 */

// 模拟两段 JSON 格式的 .ips 文件
const testContent = `{"app_name":"NNIM","timestamp":"2025-11-26 22:58:28.00 +0800","app_version":"5.12.3","slice_uuid":"8005e220-87b4-38b8-b0af-83c6194c5d64","build_version":"512003","bundleID":"com.nnhuyu.im","platform":2,"incident_id":"33E55456-EE5F-4A90-B846-1E60D2F446CC","name":"NNIM"}
{"threads":[{"triggered":true,"frames":[{"imageOffset":823300,"imageIndex":0}]}],"binaryImages":[{"name":"NNIM","base":4362076160,"size":12345678,"uuid":"8005e220-87b4-38b8-b0af-83c6194c5d64","arch":"arm64"}]}`;

console.log('====================================');
console.log('测试多行 JSON 解析');
console.log('====================================\n');

console.log('输入内容:');
console.log(testContent);
console.log('\n');

// 解析逻辑
let crashData = null;
let headerData = null;

try {
  // 尝试单个 JSON
  console.log('尝试解析为单个 JSON...');
  crashData = JSON.parse(testContent);
  console.log('✅ 成功解析为单个 JSON\n');
} catch (firstError) {
  console.log('❌ 单个 JSON 解析失败');
  console.log(`   错误: ${firstError.message}\n`);
  
  // 多行 JSON 格式
  console.log('尝试多行 JSON 格式...');
  const lines = testContent.trim().split('\n');
  console.log(`   找到 ${lines.length} 行\n`);

  // 第一遍：查找堆栈数据
  console.log('第一遍扫描：查找 threads + binaryImages...');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || !line.startsWith('{')) {
      console.log(`   第 ${i + 1} 行: 跳过（空行或非 JSON）`);
      continue;
    }
    
    try {
      const data = JSON.parse(line);
      const hasThreads = !!data.threads;
      const hasBinaryImages = !!data.binaryImages;
      
      console.log(`   第 ${i + 1} 行: threads=${hasThreads}, binaryImages=${hasBinaryImages}`);
      
      if (hasThreads && hasBinaryImages) {
        console.log(`   ✅ 找到堆栈数据在第 ${i + 1} 行`);
        crashData = data;
        break;
      }
    } catch (e) {
      console.log(`   第 ${i + 1} 行: JSON 解析失败`);
      continue;
    }
  }
  console.log('');

  // 第二遍：查找头部信息
  if (crashData) {
    console.log('第二遍扫描：查找头部信息...');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || !line.startsWith('{')) {
        console.log(`   第 ${i + 1} 行: 跳过（空行或非 JSON）`);
        continue;
      }
      
      try {
        const data = JSON.parse(line);
        const hasAppName = !!data.app_name;
        const hasTimestamp = !!data.timestamp;
        const hasIncidentId = !!data.incident_id;
        
        console.log(`   第 ${i + 1} 行: app_name=${hasAppName}, timestamp=${hasTimestamp}, incident_id=${hasIncidentId}`);
        
        if (hasAppName || hasTimestamp || hasIncidentId) {
          console.log(`   ✅ 找到头部信息在第 ${i + 1} 行`);
          headerData = data;
          break;
        }
      } catch (e) {
        console.log(`   第 ${i + 1} 行: JSON 解析失败`);
        continue;
      }
    }
    console.log('');
  }

  // 合并数据
  if (crashData && headerData) {
    console.log('合并头部信息和堆栈数据...');
    console.log(`   头部字段: ${Object.keys(headerData).join(', ')}`);
    console.log(`   堆栈字段: ${Object.keys(crashData).join(', ')}`);
    
    crashData = {
      ...headerData,
      ...crashData,
      threads: crashData.threads,
      binaryImages: crashData.binaryImages,
    };
    
    console.log(`   合并后字段: ${Object.keys(crashData).join(', ')}`);
    console.log('   ✅ 合并成功\n');
  }
}

// 输出结果
console.log('====================================');
console.log('解析结果');
console.log('====================================\n');

if (crashData) {
  console.log('✅ 解析成功\n');
  
  console.log('应用信息:');
  console.log(`   app_name: ${crashData.app_name || 'N/A'}`);
  console.log(`   app_version: ${crashData.app_version || 'N/A'}`);
  console.log(`   bundleID: ${crashData.bundleID || 'N/A'}`);
  console.log(`   timestamp: ${crashData.timestamp || 'N/A'}`);
  console.log(`   incident_id: ${crashData.incident_id || 'N/A'}`);
  console.log('');
  
  console.log('崩溃数据:');
  console.log(`   threads: ${crashData.threads ? crashData.threads.length : 0} 个`);
  console.log(`   binaryImages: ${crashData.binaryImages ? crashData.binaryImages.length : 0} 个`);
  console.log('');
  
  if (crashData.threads && crashData.threads.length > 0) {
    const crashedThread = crashData.threads.find(t => t.triggered) || crashData.threads[0];
    console.log('崩溃线程:');
    console.log(`   triggered: ${crashedThread.triggered || false}`);
    console.log(`   frames: ${crashedThread.frames ? crashedThread.frames.length : 0} 个`);
    console.log('');
  }
  
  if (crashData.binaryImages && crashData.binaryImages.length > 0) {
    const mainImage = crashData.binaryImages[0];
    console.log('主二进制:');
    console.log(`   name: ${mainImage.name || 'N/A'}`);
    console.log(`   uuid: ${mainImage.uuid || 'N/A'}`);
    console.log(`   arch: ${mainImage.arch || 'N/A'}`);
    console.log('');
  }
  
  console.log('✅ 数据完整，可以进行符号化');
} else {
  console.log('❌ 解析失败');
  console.log('   未找到有效的崩溃数据');
}

console.log('');
