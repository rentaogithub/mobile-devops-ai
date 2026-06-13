import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

const candidates = [
  path.resolve(process.cwd(), 'backend/.env'),
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '../../.env'),
  path.resolve(__dirname, '../../../backend/.env'),
];

const envPath = candidates.find((candidate) => fs.existsSync(candidate));

dotenv.config(envPath ? { path: envPath, override: true } : { override: true });
