import historyService from '../src/services/HistoryService';

console.log('测试 getAllHistoryGroupedByVersion()...\n');

const grouped = historyService.getAllHistoryGroupedByVersion();

console.log('返回的数据类型:', typeof grouped);
console.log('是否为对象:', grouped !== null && typeof grouped === 'object');
console.log('键数量:', Object.keys(grouped).length);
console.log('键列表:', Object.keys(grouped));
console.log('\n完整数据:');
console.log(JSON.stringify(grouped, null, 2));
