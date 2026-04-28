'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const os     = require('os');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');

function dataDir()                { return DATA_DIR; }
function classesDir()             { return path.join(DATA_DIR, 'classes'); }
function classDir(classId)        { return path.join(classesDir(), classId); }
function tasksDir(classId)        { return path.join(classDir(classId), 'tasks'); }
function attachmentsDir(classId)  { return path.join(classDir(classId), 'attachments'); }
function classMetaPath(classId)   { return path.join(classDir(classId), 'meta.json'); }
function taskPath(classId, taskId){ return path.join(tasksDir(classId), `${taskId}.json`); }
function authPath()               { return path.join(DATA_DIR, 'auth.json'); }
function configPath()             { return path.join(DATA_DIR, 'config.json'); }
function statusPath()             { return path.join(DATA_DIR, 'status.json'); }

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

function provisionClassDirs(classId) {
  ensureDir(classDir(classId));
  ensureDir(tasksDir(classId));
  ensureDir(attachmentsDir(classId));
}

function readJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch { return fallback; }
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmp = path.join(os.tmpdir(), `genesis-${crypto.randomBytes(6).toString('hex')}.json`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function listDir(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath).filter(f => !f.startsWith('.'));
}

function sha256(obj) {
  const str = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
}

module.exports = {
  dataDir, classesDir, classDir, tasksDir, attachmentsDir,
  classMetaPath, taskPath, authPath, configPath, statusPath,
  ensureDir, provisionClassDirs,
  readJson, writeJson, listDir, sha256,
};
