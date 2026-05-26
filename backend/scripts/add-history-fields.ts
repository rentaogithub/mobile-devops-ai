import { getDatabase } from '../src/database/connection';

// 添加新字段到历史记录表
function addHistoryFields() {
  const db = getDatabase();

  try {
    console.log('检查 symbolication_history 表的字段...');
    
    const tableInfo = db.prepare("PRAGMA table_info(symbolication_history)").all() as any[];
    const hasLastStackCall = tableInfo.some((col: any) => col.name === 'last_stack_call');
    const hasCrashModule = tableInfo.some((col: any) => col.name === 'crash_module');

    if (hasLastStackCall && hasCrashModule) {
      console.log('✅ 所有字段已存在');
      return;
    }

    if (!hasLastStackCall) {
      console.log('添加 last_stack_call 字段...');
      db.exec('ALTER TABLE symbolication_history ADD COLUMN last_stack_call TEXT');
      console.log('✅ last_stack_call 字段已添加');
    }

    if (!hasCrashModule) {
      console.log('添加 crash_module 字段...');
      db.exec('ALTER TABLE symbolication_history ADD COLUMN crash_module TEXT');
      console.log('✅ crash_module 字段已添加');
    }

    console.log('✅ 迁移完成！');
    
    // 验证字段是否添加成功
    const updatedTableInfo = db.prepare("PRAGMA table_info(symbolication_history)").all() as any[];
    console.log('\n当前表结构：');
    updatedTableInfo.forEach((col: any) => {
      console.log(`  - ${col.name} (${col.type})`);
    });
  } catch (error: any) {
    console.error('❌ 迁移失败:', error.message);
    throw error;
  }
}

// 执行迁移
console.log('开始数据库迁移...\n');
addHistoryFields();
console.log('\n迁移完成！');
process.exit(0);
