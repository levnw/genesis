'use strict';

const fsi = require('./fs');

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function createClass(meta) {
  const classId = meta.class_id || slugify(meta.name);
  const data = {
    class_id: classId,
    managebac_class_id: meta.managebac_class_id || '',
    name: meta.name,
    subject: meta.subject || '',
    enabled: meta.enabled !== false,
    last_task_seq: 0,
    created_at: new Date().toISOString(),
    ...meta,
    class_id: classId,
  };
  fsi.provisionClassDirs(classId);
  fsi.writeJson(fsi.classMetaPath(classId), data);
  return data;
}

function getClass(classId) {
  const meta = fsi.readJson(fsi.classMetaPath(classId));
  if (!meta) throw new Error(`Class "${classId}" not found`);
  return meta;
}

function updateClass(classId, updates) {
  const meta = getClass(classId);
  const updated = { ...meta, ...updates };
  fsi.writeJson(fsi.classMetaPath(classId), updated);
  return updated;
}

function listClasses() {
  return fsi.listDir(fsi.classesDir()).map(id => {
    try { return fsi.readJson(fsi.classMetaPath(id)); } catch { return null; }
  }).filter(Boolean);
}

module.exports = { slugify, createClass, getClass, updateClass, listClasses };
