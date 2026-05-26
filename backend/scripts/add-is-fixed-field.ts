#!/usr/bin/env tsx

/**
 * 数据库迁移脚本：为 symbolication_history 表添加 is_fixed 字段
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_DIR = path.resolve(__dirname, '../../dSYMTool-data');
const DB_PATH = path.join(DB_DIR, 'database.sqlite');

console.log('🔧 开始数据库迁移：添加 is_fixed 字段');
console.log(`📁 数据库路径: ${DB_PATH}`);

// 确保数据库文件存在
if (!fs.existsSync(DB_PATH)) {
  console.error('❌ 数据库文件不存在');
  process.exit(1);
}

const db = new Database(DB_PATH);

try {
  // 检查字段是否已存在
  const tableInfo = db.pragma('table_info(symbolication_history)');
  const hasIsFixed = tableInfo.some((col: any) => col.name === 'is_fixed');

  if (hasIsFixed) {
    console.log('✅ is_fixed 字段已存在，无需迁移');
  } else {
    console.log('📝 添加 is_fixed 字段...');
    
    // 添加字段
    db.exec(`
      ALTER TABLE symbolication_history 
      ADD COLUMN is_fixed INTEGER DEFAULT 0
    `);
    
    console.log('✅ is_fixed 字段添加成功');
  }

  // 显示更新后的表结构
  console.log('\n📋 当前表结构:');
  const updatedTableInfo = db.pragma('table_info(symbolication_history)');
  console.table(updatedTableInfo);

  // 统计记录数
  const count = db.prepare('SELECT COUNT(*) as count FROM symbolication_history').get() as any;
  console.log(`\n📊 历史记录总数: ${count.count}`);

} catch (error: any) {
  console.error('❌ 迁移失败:', error.message);
  process.exit(1);
} finally {
  db.close();
}

console.log('\n✅ 数据库迁移完成');
