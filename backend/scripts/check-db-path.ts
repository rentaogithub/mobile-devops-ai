import path from 'path';
import { getDatabase } from '../src/database/connection';

const projectRoot = path.resolve(__dirname, '../../');
const expectedPath = path.join(projectRoot, 'dSYMTool-data', 'database.sqlite');

console.log('项目根目录:', projectRoot);
console.log('期望的数据库路径:', expectedPath);
console.log('环境变量 DB_PATH:', process.env.DB_PATH || '(未设置)');

// 尝试查询数据库
const db = getDatabase();
const result = db.prepare('SELECT COUNT(*) as count FROM symbolication_history').get() as any;
console.log('\n数据库中的历史记录数量:', result.count);

const records = db.prepare('SELECT id, app_version, crash_type FROM symbolication_history').all();
console.log('历史记录:', records);
