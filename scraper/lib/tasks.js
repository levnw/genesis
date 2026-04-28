'use strict';

const path   = require('path');
const fsi    = require('./fs');
const classes = require('./classes');

function saveTask(classId, task) {
  if (!task.id) throw new Error('task.id is required');
  fsi.writeJson(fsi.taskPath(classId, task.id), task);
  return task;
}

function getTask(classId, taskId) {
  const task = fsi.readJson(fsi.taskPath(classId, taskId));
  if (!task) throw new Error(`Task "${taskId}" not found in ${classId}`);
  return task;
}

function listTasks(classIdOrNull = null) {
  const tasks = [];
  const classIds = classIdOrNull ? [classIdOrNull] : fsi.listDir(fsi.classesDir());
  for (const classId of classIds) {
    const dir = fsi.tasksDir(classId);
    for (const file of fsi.listDir(dir)) {
      if (!file.endsWith('.json')) continue;
      const task = fsi.readJson(path.join(dir, file));
      if (task) tasks.push(task);
    }
  }
  return tasks;
}

function nextTaskId(classId) {
  const meta = classes.getClass(classId);
  const seq  = (meta.last_task_seq || 0) + 1;
  classes.updateClass(classId, { last_task_seq: seq });
  return `task_${String(seq).padStart(5, '0')}`;
}

module.exports = { saveTask, getTask, listTasks, nextTaskId };
