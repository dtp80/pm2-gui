'use strict'

var crypto = require('crypto')
var fs = require('fs')
var path = require('path')
var _ = require('lodash')

var userData = require('./user-data')
var projectResolver = require('./project-resolver')
var pm = require('./pm')

function loadStore () {
  userData.ensureUserDataDir()
  var raw = fs.readFileSync(userData.getProjectsFile(), 'utf8')
  var store = JSON.parse(raw || '{"version":1,"projects":[]}')
  store.projects = store.projects || []
  return store
}

function saveStore (store) {
  userData.ensureUserDataDir()
  fs.writeFileSync(userData.getProjectsFile(), JSON.stringify(store, null, 2))
}

function listProjects () {
  return loadStore().projects
}

function findProject (id) {
  return _.find(listProjects(), function (p) { return p.id === id })
}

function addProject (folderPath) {
  var resolved = projectResolver.resolveProject(folderPath)
  var store = loadStore()

  var existing = _.find(store.projects, function (p) {
    return path.resolve(p.path) === path.resolve(folderPath)
  })
  if (existing) {
    return existing
  }

  var project = {
    id: crypto.randomUUID(),
    name: resolved.name,
    path: path.resolve(folderPath),
    type: resolved.type,
    script: resolved.script || null,
    configFile: resolved.configFile || null,
    addedAt: new Date().toISOString(),
    autoStart: true
  }

  store.projects.push(project)
  saveStore(store)
  return project
}

function removeProject (id) {
  var store = loadStore()
  var before = store.projects.length
  store.projects = store.projects.filter(function (p) { return p.id !== id })
  if (store.projects.length === before) {
    throw new Error('Project not found')
  }
  saveStore(store)
}

function startProject (project, options, fn) {
  if (typeof options === 'function') {
    fn = options
    options = {}
  }

  pm.startProject(_.extend({
    project: project
  }, options), fn)
}

function autoStartAll (options, fn) {
  if (typeof options === 'function') {
    fn = options
    options = {}
  }

  var projects = listProjects().filter(function (p) { return p.autoStart !== false })
  if (projects.length === 0) {
    return fn(null, [])
  }

  pm.list(options, function (err, procs) {
    if (err) {
      return fn(err)
    }

    var results = []
    var pending = projects.length
    var hadError = null

    projects.forEach(function (project) {
      var alreadyRunning = _.find(procs, function (proc) {
        var cwd = proc.pm2_env && proc.pm2_env.pm_cwd
        return cwd && path.resolve(cwd) === path.resolve(project.path)
      })

      if (alreadyRunning) {
        results.push({ project: project, status: 'already_running', pm_id: alreadyRunning.pm_id })
        if (--pending === 0) fn(hadError, results)
        return
      }

      startProject(project, options, function (err, proc) {
        if (err) {
          hadError = hadError || err
          results.push({ project: project, status: 'error', error: err.message })
        } else {
          results.push({ project: project, status: 'started', pm_id: proc && proc[0] && proc[0].pm2_env ? proc[0].pm2_env.pm_id : null })
        }
        if (--pending === 0) fn(hadError, results)
      })
    })
  })
}

module.exports = {
  ensureReady: userData.ensureUserDataDir,
  getDataDir: userData.getUserDataDir,
  listProjects: listProjects,
  findProject: findProject,
  addProject: addProject,
  removeProject: removeProject,
  startProject: startProject,
  autoStartAll: autoStartAll
}
