var _ = require('lodash')
var Monitor = require('../../lib/monitor')
var setupStatus = require('../../lib/setup-status')
var folderPicker = require('../../lib/folder-picker')
var projectsStore = require('../../lib/projects-store')
var projectUpdate = require('../../lib/project-update')
var settings = require('../../lib/settings')
var authService = require('../../lib/auth-service')
var telegram = require('../../lib/telegram')
var runtime = require('../../lib/runtime')
var db = require('../../lib/db')
var synologyBoot = require('../../lib/synology-boot')
var multer = require('multer')
var os = require('os')
var path = require('path')

var updateUpload = multer({
  dest: path.join(os.tmpdir(), 'pm2-gui-updates'),
  limits: {
    fileSize: projectUpdate.MAX_TOTAL_BYTES,
    files: 5000,
    fieldSize: 2 * 1024 * 1024
  }
})

function ensureUpdateTempDir () {
  try {
    require('fs').mkdirSync(path.join(os.tmpdir(), 'pm2-gui-updates'), { recursive: true })
  } catch (err) {}
}

function denyIfReadonly (req, res) {
  if (req._config && req._config.readonly) {
    res.status(403).json({ error: 'Server is in readonly mode.' })
    return true
  }
  return false
}

function publicWebConfig (req) {
  var fromDb = settings.getPublicConfig()
  var fromIni = (req._config && req._config.web) || {}
  return {
    public_host: fromDb.publicHost || fromIni.public_host || '',
    public_protocol: fromDb.publicProtocol || fromIni.public_protocol || 'http',
    projects_root: fromDb.projectsRoot || fromIni.projects_root || ''
  }
}

function currentUser (req) {
  if (!req.session || !req.session.userId) return null
  var user = authService.findUserById(req.session.userId)
  if (!user) return null
  return {
    id: user.id,
    username: user.username,
    totpEnabled: !!user.totp_enabled
  }
}

// Authorization page
action(function auth (req, res) {
  if (authService.isAuthenticated(req)) {
    return res.redirect('/')
  }
  var config = authService.getAuthConfig()
  res.render('auth', {
    title: 'Sign in',
    authEnabled: config.enabled,
    needsSetup: config.enabled && config.userCount === 0,
    require2fa: config.require2fa
  })
})

// Index
action(function (req, res) {
  if (!authService.isAuthenticated(req)) {
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

  var pub = publicWebConfig(req)
  var authConfig = authService.getAuthConfig()
  res.render('index', {
    title: 'Monitor',
    connections: connections,
    readonly: !!req._config.readonly,
    authorization: '',
    web: pub,
    authEnabled: authConfig.enabled,
    user: currentUser(req)
  })
})

// Login / logout / setup
action('post', 'auth_api/login', function auth_login_api (req, res) { // eslint-disable-line camelcase
  try {
    db.open()
    var body = req.body || {}
    var result = authService.login(body.username, body.password, body.totp)

    if (result.authDisabled) {
      return res.json({ status: 200, authDisabled: true })
    }

    if (result.needs2fa || result.needs2faSetup) {
      req.session.pendingUserId = result.userId
      return res.json({
        status: 202,
        needs2fa: !!result.needs2fa,
        needs2faSetup: !!result.needs2faSetup,
        username: result.username
      })
    }

    if (result.legacy) {
      req.session.authorization = body.password
      return res.json({ status: 200, legacy: true })
    }

    if (result.ok && result.user) {
      req.session.userId = result.user.id
      req.session.username = result.user.username
      delete req.session.pendingUserId
      return res.json({ status: 200, user: result.user })
    }

    return res.status(401).json({ error: 'Authentication failed' })
  } catch (err) {
    res.status(401).json({ error: err.message })
  }
})

action('post', 'auth_api/setup', function auth_setup_api (req, res) { // eslint-disable-line camelcase
  try {
    var config = authService.getAuthConfig()
    if (config.userCount > 0) {
      return res.status(400).json({ error: 'Admin user already exists' })
    }
    var body = req.body || {}
    authService.updateAuthConfig({ enabled: true })
    var user = authService.createUser(body.username, body.password)
    req.session.userId = user.id
    req.session.username = user.username
    res.json({ status: 200, user: user })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

action('post', 'auth_api/logout', function auth_logout_api (req, res) { // eslint-disable-line camelcase
  req.session.destroy(function () {
    res.json({ status: 200 })
  })
})

// Legacy token endpoint (compat)
action(function auth_api (req, res) { // eslint-disable-line camelcase
  try {
    var token = req.query && req.query.authorization
    if (!token) {
      return res.json({ error: 'Authorization is required!' })
    }
    var result = authService.login('legacy', token)
    if (result.ok) {
      req.session.authorization = token
      if (result.user) {
        req.session.userId = result.user.id
      }
      return res.json({ status: 200 })
    }
    return res.json({ error: 'Failed, authorization is incorrect.' })
  } catch (err) {
    return res.json({ error: err.message })
  }
})

// Setup / health status for the dashboard
action(function status_api (req, res) { // eslint-disable-line camelcase
  if (!authService.isAuthenticated(req)) {
    return res.status(401).json({ error: 'Authentication required' })
  }
  setupStatus.getSetupStatusAsync(req._config, function (err, status) {
    if (err) {
      return res.status(500).json({ error: err.message })
    }
    res.json(status)
  })
})

// Settings API
action('get', 'settings_api', function settings_api_get (req, res) { // eslint-disable-line camelcase
  if (!authService.isAuthenticated(req)) {
    return res.status(401).json({ error: 'Authentication required' })
  }
  try {
    var allSettings = settings.getSettings()
    delete allSettings.session_secret
    synologyBoot.getStatus(function (bootErr, startup) {
      res.json({
        settings: allSettings,
        auth: authService.getAuthConfig(),
        telegram: telegram.getConfig(),
        users: authService.listUsers(),
        user: currentUser(req),
        dataDir: projectsStore.getDataDir(),
        dbPath: db.getDbPath(),
        startup: bootErr ? { error: bootErr.message } : startup
      })
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

function handleSettingsUpdate (req, res) {
  if (!authService.isAuthenticated(req)) {
    return res.status(401).json({ error: 'Authentication required' })
  }
  try {
    var body = req.body || {}
    if (body.settings) {
      settings.updateSettings(body.settings)
      runtime.reloadSettings()
      if (req._config) {
        settings.applyToOptions(req._config)
      }
    }
    if (body.auth) {
      authService.updateAuthConfig(body.auth)
    }
    if (body.telegram) {
      telegram.updateConfig(body.telegram)
    }
    var saved = settings.getSettings()
    delete saved.session_secret
    res.json({
      status: 'ok',
      settings: saved,
      auth: authService.getAuthConfig(),
      telegram: telegram.getConfig(),
      users: authService.listUsers(),
      user: currentUser(req),
      dataDir: projectsStore.getDataDir(),
      dbPath: db.getDbPath()
    })
  } catch (err) {
    console.error('[settings] update failed:', err)
    res.status(400).json({ error: err.message || 'Could not save settings' })
  }
}

action('post', 'settings_api', handleSettingsUpdate)
action('put', 'settings_api', handleSettingsUpdate)
action('post', 'settings_api/save', handleSettingsUpdate)

action('post', 'settings_api/telegram/test', function settings_telegram_test_api (req, res) { // eslint-disable-line camelcase
  if (!authService.isAuthenticated(req)) {
    return res.status(401).json({ error: 'Authentication required' })
  }
  telegram.sendTest(function (err) {
    if (err) {
      return res.status(500).json({ error: err.message })
    }
    res.json({ status: 'ok' })
  })
})

action('get', 'settings_api/startup', function settings_startup_get_api (req, res) { // eslint-disable-line camelcase
  if (!authService.isAuthenticated(req)) {
    return res.status(401).json({ error: 'Authentication required' })
  }
  synologyBoot.getStatus(function (err, status) {
    if (err) {
      return res.status(500).json({ error: err.message })
    }
    res.json(status)
  })
})

action('post', 'settings_api/startup', function settings_startup_post_api (req, res) { // eslint-disable-line camelcase
  if (!authService.isAuthenticated(req)) {
    return res.status(401).json({ error: 'Authentication required' })
  }
  var body = req.body || {}
  synologyBoot.setupBootTask({
    preferCrontab: true,
    appDir: body.appDir,
    userHome: body.userHome
  }, function (err, result) {
    if (err) {
      return res.status(500).json({ error: err.message })
    }
    res.json(result)
  })
})

action('post', 'settings_api/users', function settings_create_user_api (req, res) { // eslint-disable-line camelcase
  if (!authService.isAuthenticated(req)) {
    return res.status(401).json({ error: 'Authentication required' })
  }
  try {
    var body = req.body || {}
    var user = authService.createUser(body.username, body.password)
    res.json({ user: user })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

action('post', 'settings_api/password', function settings_password_api (req, res) { // eslint-disable-line camelcase
  if (!authService.isAuthenticated(req) || !req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' })
  }
  try {
    var body = req.body || {}
    authService.changePassword(req.session.userId, body.currentPassword, body.newPassword)
    res.json({ status: 'ok' })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

action('post', 'settings_api/2fa/begin', function settings_2fa_begin_api (req, res) { // eslint-disable-line camelcase
  if (!authService.isAuthenticated(req) || !req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' })
  }
  authService.beginTotpSetup(req.session.userId).then(function (data) {
    res.json(data)
  }).catch(function (err) {
    res.status(400).json({ error: err.message })
  })
})

action('post', 'settings_api/2fa/confirm', function settings_2fa_confirm_api (req, res) { // eslint-disable-line camelcase
  if (!authService.isAuthenticated(req) || !req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' })
  }
  try {
    var result = authService.confirmTotpSetup(req.session.userId, req.body && req.body.code)
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

action('post', 'settings_api/2fa/disable', function settings_2fa_disable_api (req, res) { // eslint-disable-line camelcase
  if (!authService.isAuthenticated(req) || !req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' })
  }
  try {
    var body = req.body || {}
    var result = authService.disableTotp(req.session.userId, body.password, body.code)
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// Saved project folders
action('get', function projects_api (req, res) { // eslint-disable-line camelcase
  if (!authService.isAuthenticated(req)) {
    return res.status(401).json({ error: 'Authentication required' })
  }
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
  if (!authService.isAuthenticated(req)) {
    return res.status(401).json({ error: 'Authentication required' })
  }
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
      var extras = {}
      if (req.body && req.body.servicePort) {
        extras.servicePort = req.body.servicePort
      }
      if (req.body && req.body.serviceUrl) {
        extras.serviceUrl = req.body.serviceUrl
      }
      var project = projectsStore.addProject(folder, extras)
      res.json({ project: project })
    } catch (addErr) {
      res.status(400).json({ error: addErr.message })
    }
  })
})

action('post', 'projects_api/add', function projects_add_api (req, res) { // eslint-disable-line camelcase
  if (!authService.isAuthenticated(req)) {
    return res.status(401).json({ error: 'Authentication required' })
  }
  if (denyIfReadonly(req, res)) {
    return
  }

  var folder = req.body && req.body.path
  if (!folder) {
    return res.status(400).json({ error: 'path is required' })
  }

  try {
    var extras = {}
    if (req.body && req.body.servicePort) {
      extras.servicePort = req.body.servicePort
    }
    if (req.body && req.body.serviceUrl) {
      extras.serviceUrl = req.body.serviceUrl
    }
    var project = projectsStore.addProject(folder, extras)
    res.json({ project: project })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

action('delete', 'projects_api/:id', function projects_delete_api (req, res) { // eslint-disable-line camelcase
  if (!authService.isAuthenticated(req)) {
    return res.status(401).json({ error: 'Authentication required' })
  }
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
  if (!authService.isAuthenticated(req)) {
    return res.status(401).json({ error: 'Authentication required' })
  }
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
  if (!authService.isAuthenticated(req)) {
    return res.status(401).json({ error: 'Authentication required' })
  }
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

function handleProjectUpdateUpload (req, res, target) {
  ensureUpdateTempDir()
  updateUpload.any()(req, res, function (err) {
    if (err) {
      return res.status(400).json({ error: err.message || 'Upload failed' })
    }

    var files = req.files || []
    var fields = req.body || {}
    if (typeof fields.paths === 'string') {
      try {
        fields.paths = JSON.parse(fields.paths)
      } catch (parseErr) {
        fields.paths = [fields.paths]
      }
    }

    var opts = {
      pm2Home: req._config && req._config.pm2,
      files: files,
      fields: fields
    }
    if (target.projectId) opts.projectId = target.projectId
    if (target.pmId != null) opts.pmId = target.pmId

    projectUpdate.applyUpdate(opts, function (updateErr, result) {
      projectUpdate.cleanupFiles(files)
      if (updateErr) {
        return res.status(500).json({ error: updateErr.message })
      }
      res.json(result)
    })
  })
}

action('post', 'projects_api/:id/update', function projects_update_api (req, res) { // eslint-disable-line camelcase
  if (!authService.isAuthenticated(req)) {
    return res.status(401).json({ error: 'Authentication required' })
  }
  if (denyIfReadonly(req, res)) {
    return
  }
  if (!projectsStore.findProject(req.params.id)) {
    return res.status(404).json({ error: 'Project not found' })
  }
  handleProjectUpdateUpload(req, res, { projectId: req.params.id })
})

action('post', 'processes_api/:pmId/update', function processes_update_api (req, res) { // eslint-disable-line camelcase
  if (!authService.isAuthenticated(req)) {
    return res.status(401).json({ error: 'Authentication required' })
  }
  if (denyIfReadonly(req, res)) {
    return
  }
  handleProjectUpdateUpload(req, res, { pmId: req.params.pmId })
})

action('post', 'projects_api/create_from_upload', function projects_create_from_upload_api (req, res) { // eslint-disable-line camelcase
  if (!authService.isAuthenticated(req)) {
    return res.status(401).json({ error: 'Authentication required' })
  }
  if (denyIfReadonly(req, res)) {
    return
  }

  ensureUpdateTempDir()
  updateUpload.any()(req, res, function (err) {
    if (err) {
      return res.status(400).json({ error: err.message || 'Upload failed' })
    }

    var files = req.files || []
    var fields = req.body || {}
    if (typeof fields.paths === 'string') {
      try {
        fields.paths = JSON.parse(fields.paths)
      } catch (parseErr) {
        fields.paths = [fields.paths]
      }
    }

    projectUpdate.createFromUpload({
      pm2Home: req._config && req._config.pm2,
      files: files,
      fields: fields
    }, function (createErr, result) {
      projectUpdate.cleanupFiles(files)
      if (createErr) {
        return res.status(500).json({ error: createErr.message })
      }
      res.json(result)
    })
  })
})
