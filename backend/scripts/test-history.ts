import historyService from '../src/services/HistoryService';

async function testHistory() {
  console.log('开始测试历史记录功能...\n');

  // 测试数据
  const testData = {
    appVersion: '5.12.3',
    crashType: '程序异常终止（SIGKILL）',
    crashReason: 'Watchdog 超时',
    lastStackCall: 'ImageContainerNewView.collectionView(_:cellForItemAt:)',
    crashModule: 'NNIM',
    crashLocation: '@objc ImageContainerNewView.collectionView(_:cellForItemAt:) (in NNIM)',
    originalLog: 'Test crash log original...',
    symbolicatedLog: 'Test crash log symbolicated...',
    usedUuids: ['8005E220-87B4-38B8-B0AF-83C6194C5D64', '4C4C44A8-5555-3144-A119-54B84805F5A2'],
    aiAnalysis: {
      crashType: '程序异常终止（SIGKILL）',
      severity: 'high',
      summary: '测试崩溃分析'
    }
  };

  try {
    // 保存历史记录
    console.log('1. 保存历史记录...');
    const saved = await historyService.saveHistory(testData);
    console.log('✓ 保存成功:', {
      id: saved.id,
      appVersion: saved.appVersion,
      crashType: saved.crashType,
      crashLocation: saved.crashLocation
    });

    // 获取所有历史记录
    console.log('\n2. 获取所有历史记录...');
    const allHistory = historyService.getAllHistoryGroupedByVersion();
    console.log('✓ 历史记录数量:', Object.keys(allHistory).length);
    for (const [version, records] of Object.entries(allHistory)) {
      console.log(`  版本 ${version}: ${records.length} 条记录`);
      records.forEach(record => {
        console.log(`    - ID: ${record.id}, 崩溃类型: ${record.crashType}, 崩溃位置: ${record.crashLocation}`);
      });
    }

    // 根据版本获取历史记录
    console.log('\n3. 根据版本获取历史记录...');
    const versionHistory = historyService.getHistoryByVersion('5.12.3');
    console.log(`✓ 版本 5.12.3 的历史记录: ${versionHistory.length} 条`);

    // 获取统计信息
    console.log('\n4. 获取统计信息...');
    const stats = historyService.getStatistics();
    console.log('✓ 统计信息:', stats);

    console.log('\n✓ 所有测试通过！');
  } catch (error: any) {
    console.error('✗ 测试失败:', error.message);
    console.error(error);
  }
}

testHistory();
