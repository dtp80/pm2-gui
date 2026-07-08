var _ = require('lodash')
var Monitor = require('../../lib/monitor')
var setupStatus = require('../../lib/setup-status')
var folderPicker = require('../../lib/folder-picker')
var projectsStore = require('../../lib/projects-store')

function denyIfReadonly (req, res) {
  if (req._config && req._config.readonly) {
    res.status(403).json({ error: 'Server is in readonly mode.' })
    return true
  }
  return false
}

// Authorization
action(function auth (req, res) {
  if (!req._config.agent || (req._config.agent.authorization === req.session['authorization'])) {
    return res.redirect('/')
  }
  res.render('auth', {
    title: 'Authorization'
  })
})

// Index
action(function (req, res) {
  if (req._config.agent && (req._config.agent.authorization !== req.session['authorization'])) {
    return res.redirect('/auth')
  }
  var options = _.clone(req._config)
  var q = Monitor.available(_.extend(options, {
    blank: '&nbsp;'
  }))
  var connections = []

  q.choices.forEach(function (c) {
    c.value = Monitor.toConnectionString(Monitor.parseConnectionString(c.value))
    connections.push(c)
  })
  res.render('index', {
    title: 'Monitor',
    connections: connections,
    readonly: !!req._config.readonly,
    authorization: req._config.agent && req._config.agent.authorization
  })
})

// API
action(function auth_api (req, res) { // eslint-disable-line camelcase
  if (!req._config.agent || !req._config.agent.authorization) {
    return res.json({
      error: 'Can not found agent[.authorization] config, no need to authorize!'
    })
  }
  if (!req.query || !req.query.authorization) {
    return res.json({
      error: 'Authorization is required!'
    })
  }

  if (req._config.agent && req.query.authorization === req._config.agent.authorization) {
    req.session['authorization'] = req.query.authorization
    return res.json({
      status: 200
    })
  }
  return res.json({
    error: 'Failed, authorization is incorrect.'
  })
})

// Setup / health status for the dashboard
action(function status_api (req, res) { // eslint-disable-line camelcase
  setupStatus.getSetupStatusAsync(req._config, function (err, status) {
    if (err) {
      return res.status(500).json({ error: err.message })
    }
    res.json(status)
  })
})

// Saved project folders (per OS user, stored in app data directory)
action('get', function projects_api (req, res) { // eslint-disable-line camelcase
  try {
    projectsStore.ensureReady()
    res.json({
      dataDir: projectsStore.getDataDir(),
      projects: projectsStore.listProjects()
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

action('post', 'projects_api/browse', function projects_browse_api (req, res) { // eslint-disable-line camelcase
  if (denyIfReadonly(req, res)) {
    return
  }

  folderPicker.pickFolder({ prompt: 'Select a folder containing a PM2 process' }, function (err, folder) {
    if (err) {
      return res.status(500).json({ error: err.message })
    }
    if (!folder) {
      return res.json({ canceled: true })
    }

    try {
      var project = projectsStore.addProject(folder)
      res.json({ project: project })
    } catch (addErr) {
      res.status(400).json({ error: addErr.message })
    }
  })
})

action('post', 'projects_api/add', function projects_add_api (req, res) { // eslint-disable-line camelcase
  if (denyIfReadonly(req, res)) {
    return
  }

  var folder = req.body && req.body.path
  if (!folder) {
    return res.status(400).json({ error: 'path is required' })
  }

  try {
    var project = projectsStore.addProject(folder)
    res.json({ project: project })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

action('delete', 'projects_api/:id', function projects_delete_api (req, res) { // eslint-disable-line camelcase
  if (denyIfReadonly(req, res)) {
    return
  }

  try {
    projectsStore.removeProject(req.params.id)
    res.json({ status: 'ok' })
  } catch (err) {
    res.status(404).json({ error: err.message })
  }
})

action('post', 'projects_api/:id/start', function projects_start_api (req, res) { // eslint-disable-line camelcase
  if (denyIfReadonly(req, res)) {
    return
  }

  var project = projectsStore.findProject(req.params.id)
  if (!project) {
    return res.status(404).json({ error: 'Project not found' })
  }

  projectsStore.startProject(project, { pm2Home: req._config.pm2 }, function (err, proc) {
    if (err) {
      return res.status(500).json({ error: err.message })
    }
    res.json({ status: 'started', project: project, process: proc })
  })
})

action('post', 'projects_api/start_all', function projects_start_all_api (req, res) { // eslint-disable-line camelcase
  if (denyIfReadonly(req, res)) {
    return
  }

  projectsStore.autoStartAll({ pm2Home: req._config.pm2 }, function (err, results) {
    if (err && (!results || results.length === 0)) {
      return res.status(500).json({ error: err.message })
    }
    res.json({ results: results, partialError: err ? err.message : null })
  })
})
