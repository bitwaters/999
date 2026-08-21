import { cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const source = path.resolve('src/persistence/migrations');
const target = path.resolve('dist/persistence/migrations');
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
