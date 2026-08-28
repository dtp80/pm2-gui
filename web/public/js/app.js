;(function () {
  'use strict'
  var NSP = {
    SYS: '/system',
    LOG: '/log',
    PROCESS: '/proccess'
  }

  var EVENTS = {
    ERROR: 'error',
    CONNECT: 'connect',
    CONNECT_ERROR: 'connect_error',
    DISCONNECT: 'disconnect',
    DATA: 'data',
    DATA_PROCESSES: 'data.processes',
    DATA_SYSTEM_STATS: 'data.sysstat',
    DATA_PM2_VERSION: 'data.pm2version',
    DATA_ACTION: 'data.action',
    DATA_USAGE: 'data.usage',
    PULL_LOGS: 'pull.log',
    PULL_LOGS_END: 'pull.log_end',
    PULL_USAGE: 'pull.usage',
    PULL_PROCESSES: 'pull.processes',
    PULL_ACTION: 'pull.action'
  }

  var CONNECT_TIMEOUT_MS = 8000

  var state = {
    sysStat: null,
    processes: [],
    sockets: {},
    selectedProc: null,
    monitorData: [],
    logAutoScroll: true,
    connected: false,
    connectionValue: null,
    connectTimer: null,
    setupData: null,
    savedProjects: [],
    projectsLoading: false,
    browsingFolder: false,
    startup: null
  }

  var els = {}

  boot()

  function boot () {
    try {
      document.documentElement.dataset.pm2guiBoot = 'starting'
      init()
      document.documentElement.dataset.pm2guiBoot = 'done'
    } catch (err) {
      document.documentElement.dataset.pm2guiBoot = 'error'
      document.documentElement.dataset.pm2guiError = err.message
      cacheElements()
      showSetupModal('Dashboard failed to start: ' + err.message)
    }
  }

  function init () {
    cacheElements()

    if (typeof io === 'undefined') {
      showFatal('Socket.IO client failed to load. Restart pm2-gui and reload this page.')
      return
    }

    bindUI()

    if (!Array.isArray(window.GUI.connections) || window.GUI.connections.length === 0) {
      showSetupModal('No monitoring agent is configured.')
      return
    }

    var connection = window.GUI.connections[window.GUI.connections.length - 1]
    if (els.agentSelect) {
      els.agentSelect.addEventListener('change', function () {
        reconnect(els.agentSelect.value)
      })
      connection = window.GUI.connections.find(function (c) {
        return c.value === els.agentSelect.value
      }) || connection
    }

    loadSetupStatus()
    loadSavedProjects()
    connectAll(connection.value)
  }

  function cacheElements () {
    els = {
      pm2Version: document.getElementById('pm2-version'),
      statHostname: document.getElementById('stat-hostname'),
      statPlatform: document.getElementById('stat-platform'),
      statCpu: document.getElementById('stat-cpu'),
      statCpuBar: document.getElementById('stat-cpu-bar'),
      statMemory: document.getElementById('stat-memory'),
      statMemoryBar: document.getElementById('stat-memory-bar'),
      statUptime: document.getElementById('stat-uptime'),
      statProcesses: document.getElementById('stat-processes'),
      processCount: document.getElementById('process-count'),
      processList: document.getElementById('process-list'),
      toastContainer: document.getElementById('toast-container'),
      modal: document.getElementById('process-modal'),
      modalTitle: document.getElementById('modal-title'),
      modalSubtitle: document.getElementById('modal-subtitle'),
      modalInfo: document.getElementById('modal-info'),
      modalLog: document.getElementById('modal-log'),
      monitorChart: document.getElementById('monitor-chart'),
      agentSelect: document.getElementById('agent-select'),
      setupModal: document.getElementById('setup-modal'),
      setupSummary: document.getElementById('setup-summary'),
      setupStatus: document.getElementById('setup-status'),
      setupSteps: document.getElementById('setup-steps'),
      setupRetry: document.getElementById('setup-retry'),
      setupCopy: document.getElementById('setup-copy'),
      addProjectBtn: document.getElementById('add-project-btn'),
      startProjectsBtn: document.getElementById('start-projects-btn'),
      addProjectModal: document.getElementById('add-project-modal'),
      addProjectPath: document.getElementById('add-project-path'),
      addProjectBrowse: document.getElementById('add-project-browse'),
      addProjectSubmit: document.getElementById('add-project-submit'),
      addProjectPort: document.getElementById('add-project-port'),
      settingsBtn: document.getElementById('settings-btn'),
      settingsModal: document.getElementById('settings-modal')
    }
  }

  function bindUI () {
    document.body.addEventListener('click', function (event) {
      var target = event.target

      if (target.dataset.close === 'setup') {
        hideSetupModal()
        return
      }

      if (target.dataset.close === 'add-project') {
        hideAddProjectModal()
        return
      }

      if (target.dataset.close === 'settings') {
        hideSettingsModal()
        return
      }

      if (target.dataset.settingsTab) {
        switchSettingsTab(target.dataset.settingsTab)
        return
      }

      if (target.id === 'settings-btn') {
        showSettingsModal()
        return
      }

      if (target.id === 'settings-save') {
        saveSettings()
        return
      }

      if (target.id === 'setting-create-user') {
        createSettingsUser()
        return
      }

      if (target.id === 'setting-tg-test') {
        testTelegram()
        return
      }

      if (target.id === 'setting-startup-create') {
        createStartupTask()
        return
      }

      if (target.id === 'setting-startup-copy') {
        copyStartupCommand()
        return
      }

      if (target.id === 'setting-change-password') {
        changeSettingsPassword()
        return
      }

      if (target.id === 'setting-2fa-begin') {
        begin2faSetup()
        return
      }

      if (target.id === 'setting-2fa-confirm') {
        confirm2faSetup()
        return
      }

      if (target.id === 'setting-2fa-disable') {
        disable2fa()
        return
      }

      if (target.id === 'setting-logout') {
        logout()
        return
      }

      if (target.dataset.close === 'modal') {
        closeModal()
        return
      }

      if (target.dataset.tab) {
        switchTab(target.dataset.tab)
        return
      }

      if (target.id === 'setup-retry') {
        reconnect(state.connectionValue || getCurrentConnection())
        return
      }

      if (target.id === 'setup-copy') {
        copySetupCommands()
        return
      }

      if (target.id === 'add-project-btn') {
        showAddProjectModal()
        return
      }

      if (target.id === 'add-project-browse') {
        browseProjectFolder()
        return
      }

      if (target.id === 'add-project-submit') {
        submitProjectPath()
        return
      }

      if (target.id === 'start-projects-btn') {
        startAllSavedProjects()
        return
      }

      if (target.dataset.projectStart) {
        startSavedProject(target.dataset.projectStart, target)
        return
      }

      if (target.dataset.projectRemove) {
        removeSavedProject(target.dataset.projectRemove, target)
        return
      }

      if (target.dataset.projectDelete) {
        deleteSavedProjectRow(target.dataset.projectDelete, target)
        return
      }

      if (target.dataset.action && !window.GUI.readonly) {
        var id = target.dataset.id
        var action = target.dataset.action
        if (action === 'delete' && id !== 'all' && !confirm('Delete this process and remove it from saved projects?')) {
          return
        }
        if (action === 'delete' && id === 'all' && !confirm('Delete ALL processes?')) {
          return
        }
        runAction(action, id, target)
        return
      }

      var row = target.closest('[data-pmid]')
      if (row && row.dataset.pmid !== undefined && !target.closest('a, button')) {
        openProcessModal(parseInt(row.dataset.pmid, 10))
      }
    })
  }

  function connectAll (connectionValue) {
    disconnectAll()
    clearConnectTimer()
    state.connectionValue = connectionValue
    state.connected = false
    setConnectionStatus('Connecting...', 'pending')

    state.sockets.sys = connectSocket(connectionValue, NSP.SYS)
    state.sockets.process = connectSocket(connectionValue, NSP.PROCESS)

    wireSocket(state.sockets.sys, {
      onConnect: function () {
        markPartiallyConnected('Connected to monitor')
      },
      onVersion: function (info) {
        applyPm2Version(info)
      },
      onSysStat: onSystemStats,
      onError: onSocketError
    })

    wireSocket(state.sockets.process, {
      onConnect: function () {
        state.sockets.process.emit(EVENTS.PULL_PROCESSES)
      },
      onProcesses: onProcesses,
      onError: onSocketError
    })

    state.connectTimer = setTimeout(function () {
      if (!state.connected) {
        showSetupModal('Could not connect to the pm2-gui monitor within ' + (CONNECT_TIMEOUT_MS / 1000) + ' seconds.')
      }
    }, CONNECT_TIMEOUT_MS)
  }

  function wireSocket (socket, handlers) {
    socket.on(EVENTS.CONNECT, function () {
      handlers.onConnect && handlers.onConnect()
    })
    socket.on(EVENTS.CONNECT_ERROR, handlers.onError || onSocketError)
    socket.on(EVENTS.DISCONNECT, function () {
      if (state.connected) {
        setConnectionStatus('Reconnecting...', 'pending')
      }
    })

    if (handlers.onVersion) {
      socket.on(EVENTS.DATA_PM2_VERSION, handlers.onVersion)
    }
    if (handlers.onSysStat) {
      socket.on(EVENTS.DATA_SYSTEM_STATS, handlers.onSysStat)
    }
    if (handlers.onProcesses) {
      socket.on(EVENTS.DATA_PROCESSES, handlers.onProcesses)
    }

    socket.on(EVENTS.DATA_ACTION, function (payload) {
      if (payload && payload.error) {
        toast(payload.error, 'error')
        return
      }
      if (payload && payload.success && payload.action === 'delete') {
        loadSavedProjects()
      }
    })
    socket.on(EVENTS.ERROR, handlers.onError || onSocketError)
  }

  function reconnect (connectionValue) {
    hideSetupModal()
    connectAll(connectionValue)
    loadSetupStatus()
  }

  function disconnectAll () {
    clearConnectTimer()
    Object.keys(state.sockets).forEach(function (key) {
      if (state.sockets[key]) {
        state.sockets[key].disconnect()
      }
    })
    state.sockets = {}
    closeLogSocket()
    stopMonitor()
  }

  function connectSocket (connectionValue, namespace) {
    var uri = connectionValue
    var pageHost = location.hostname
    var pageIsLocal = pageHost === 'localhost' || pageHost === '127.0.0.1'

    if (pageIsLocal && (/127\.0\.0\.1|localhost/.test(uri))) {
      uri = uri.replace(/^https?:\/\/[^/?]+/, location.origin.replace(/\/$/, ''))
    } else if (!pageIsLocal) {
      uri = uri.replace(/^https?:\/\/[^/?]+/, location.origin.replace(/\/$/, ''))
    }

    var index = uri.indexOf('?')
    var query = ''
    if (index >= 0) {
      query = uri.slice(index)
      uri = uri.slice(0, index)
    }

    uri = uri.replace(/\/$/, '') + (namespace || '') + query

    var auth = document.getElementById('authorization')
    if (auth && auth.value && uri.indexOf('auth=') < 0) {
      uri += (uri.indexOf('?') >= 0 ? '&' : '?') + 'auth=' + encodeURIComponent(auth.value)
    }

    return io(uri, {
      transports: ['websocket', 'polling'],
      forceNew: true,
      timeout: CONNECT_TIMEOUT_MS,
      reconnection: true,
      reconnectionAttempts: 10
    })
  }

  function markPartiallyConnected (label) {
    setConnectionStatus(label, 'pending')
  }

  function markConnected (label) {
    state.connected = true
    clearConnectTimer()
    hideSetupModal()
    setConnectionStatus(label, 'ok')
  }

  function applyPm2Version (info) {
    if (typeof info === 'string') {
      markConnected('PM2 v' + info)
      if (els.pm2Version) {
        els.pm2Version.title = ''
      }
      return
    }

    var label = 'PM2 v' + (info.version || '0.0.0')
    markConnected(label)

    if (els.pm2Version && info.updateRecommended) {
      els.pm2Version.title = 'Daemon is v' + info.daemon + '. Run: pm2 update'
      els.pm2Version.dataset.state = 'pending'
    } else if (els.pm2Version) {
      els.pm2Version.title = ''
    }
  }

  function setConnectionStatus (label, tone) {
    els.pm2Version.textContent = label
    els.pm2Version.dataset.state = tone || 'pending'
  }

  function clearConnectTimer () {
    if (state.connectTimer) {
      clearTimeout(state.connectTimer)
      state.connectTimer = null
    }
  }

  function loadSavedProjects () {
    state.projectsLoading = true
    fetch('/projects_api', { credentials: 'same-origin' })
      .then(function (res) { return res.json() })
      .then(function (data) {
        state.savedProjects = data.projects || []
        renderProcessTable()
      })
      .catch(function (err) {
        toast('Could not load saved project folders.', 'error')
      })
      .finally(function () {
        state.projectsLoading = false
      })
  }

  function normalizePath (value) {
    return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  }

  function findProjectForProcess (proc) {
    var cwd = proc.pm2_env && proc.pm2_env.pm_cwd
    if (!cwd) {
      return null
    }
    var normalized = normalizePath(cwd)
    return state.savedProjects.find(function (project) {
      return normalizePath(project.path) === normalized
    }) || null
  }

  function findProcessForProject (project) {
    var normalized = normalizePath(project.path)
    return state.processes.find(function (proc) {
      var cwd = proc.pm2_env && proc.pm2_env.pm_cwd
      return cwd && normalizePath(cwd) === normalized
    }) || null
  }

  function getUnmanagedSavedProjects () {
    return state.savedProjects.filter(function (project) {
      return !findProcessForProject(project)
    })
  }

  function showAddProjectModal () {
    if (!els.addProjectModal || window.GUI.readonly) {
      return
    }
    els.addProjectModal.hidden = false
    if (els.addProjectPath) {
      els.addProjectPath.value = els.addProjectPath.value || ''
      setTimeout(function () { els.addProjectPath.focus() }, 50)
      if (!els.addProjectPath.dataset.boundEnter) {
        els.addProjectPath.dataset.boundEnter = '1'
        els.addProjectPath.addEventListener('keydown', function (event) {
          if (event.key === 'Enter') {
            event.preventDefault()
            submitProjectPath()
          }
        })
      }
    }
  }

  function hideAddProjectModal () {
    if (els.addProjectModal) {
      els.addProjectModal.hidden = true
    }
  }

  function browseProjectFolder () {
    if (window.GUI.readonly || state.browsingFolder) {
      return
    }

    state.browsingFolder = true
    if (els.addProjectBrowse) {
      els.addProjectBrowse.disabled = true
      els.addProjectBrowse.textContent = 'Browsing…'
    }

    fetch('/projects_api/browse', {
      method: 'POST',
      credentials: 'same-origin'
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body } }) })
      .then(function (result) {
        if (!result.ok) {
          throw new Error(result.body.error || 'Could not open folder picker')
        }
        if (result.body.canceled) {
          return
        }
        if (result.body.project && result.body.project.path && els.addProjectPath) {
          els.addProjectPath.value = result.body.project.path
        }
        toast('Saved project folder: ' + result.body.project.name)
        hideAddProjectModal()
        loadSavedProjects()
      })
      .catch(function (err) {
        toast(err.message + ' Use the path field instead.', 'error')
      })
      .finally(function () {
        state.browsingFolder = false
        if (els.addProjectBrowse) {
          els.addProjectBrowse.disabled = false
          els.addProjectBrowse.textContent = 'Browse'
        }
      })
  }

  function submitProjectPath () {
    if (window.GUI.readonly || state.browsingFolder) {
      return
    }

    var folder = els.addProjectPath ? els.addProjectPath.value.trim() : ''
    if (!folder) {
      toast('Enter a project folder path.', 'error')
      if (els.addProjectPath) els.addProjectPath.focus()
      return
    }

    var payload = { path: folder }
    if (els.addProjectPort && els.addProjectPort.value.trim()) {
      payload.servicePort = parseInt(els.addProjectPort.value.trim(), 10)
    }

    state.browsingFolder = true
    if (els.addProjectSubmit) {
      els.addProjectSubmit.disabled = true
      els.addProjectSubmit.textContent = 'Adding…'
    }

    fetch('/projects_api/add', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body } }) })
      .then(function (result) {
        if (!result.ok) {
          throw new Error(result.body.error || 'Could not add project folder')
        }
        toast('Saved project folder: ' + result.body.project.name)
        if (els.addProjectPath) {
          els.addProjectPath.value = ''
        }
        if (els.addProjectPort) {
          els.addProjectPort.value = ''
        }
        hideAddProjectModal()
        loadSavedProjects()
      })
      .catch(function (err) {
        toast(err.message, 'error')
      })
      .finally(function () {
        state.browsingFolder = false
        if (els.addProjectSubmit) {
          els.addProjectSubmit.disabled = false
          els.addProjectSubmit.textContent = 'Add project'
        }
      })
  }

  function startSavedProject (projectId, button) {
    if (button) {
      button.disabled = true
    }

    fetch('/projects_api/' + encodeURIComponent(projectId) + '/start', {
      method: 'POST',
      credentials: 'same-origin'
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body } }) })
      .then(function (result) {
        if (!result.ok) {
          throw new Error(result.body.error || 'Could not start project')
        }
        toast('Started ' + result.body.project.name)
        if (state.sockets.process && state.sockets.process.connected) {
          state.sockets.process.emit(EVENTS.PULL_PROCESSES)
        }
      })
      .catch(function (err) {
        toast(err.message, 'error')
      })
      .finally(function () {
        if (button) {
          button.disabled = false
        }
      })
  }

  function startAllSavedProjects () {
    if (window.GUI.readonly) {
      return
    }

    fetch('/projects_api/start_all', {
      method: 'POST',
      credentials: 'same-origin'
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body } }) })
      .then(function (result) {
        if (!result.ok && !result.body.results) {
          throw new Error(result.body.error || 'Could not start saved projects')
        }
        var started = (result.body.results || []).filter(function (r) { return r.status === 'started' }).length
        toast(started > 0 ? 'Started ' + started + ' saved project(s)' : 'Saved projects are already running or unavailable')
        if (state.sockets.process && state.sockets.process.connected) {
          state.sockets.process.emit(EVENTS.PULL_PROCESSES)
        }
      })
      .catch(function (err) {
        toast(err.message, 'error')
      })
  }

  function removeSavedProject (projectId, button) {
    if (button) {
      button.disabled = true
    }

    fetch('/projects_api/' + encodeURIComponent(projectId), {
      method: 'DELETE',
      credentials: 'same-origin'
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body } }) })
      .then(function (result) {
        if (!result.ok) {
          throw new Error(result.body.error || 'Could not remove project')
        }
        toast('Removed saved folder')
        loadSavedProjects()
      })
      .catch(function (err) {
        toast(err.message, 'error')
      })
      .finally(function () {
        if (button) {
          button.disabled = false
        }
      })
  }

  function deleteSavedProjectRow (projectId, button) {
    if (!confirm('Remove this saved project from your list?')) {
      return
    }
    removeSavedProject(projectId, button)
  }

  function onSocketError (err) {
    var message = typeof err === 'string' ? err : (err && err.message) || 'Connection error'
    if (message === 'unauthorized') {
      message = 'Authentication failed. Check your authorization token in pm2-gui.ini.'
      showSetupModal(message)
    }
    toast(message, 'error')
  }

  function onSystemStats (data) {
    state.sysStat = data
    markConnected(els.pm2Version.textContent.indexOf('PM2 v') === 0 ? els.pm2Version.textContent : 'Connected')
    els.statHostname.textContent = data.hostname || '—'
    els.statPlatform.textContent = (data.platform || '') + ' ' + (data.release || '')
    els.statCpu.textContent = (data.cpu || 0) + '%'
    els.statCpuBar.style.width = Math.min(parseFloat(data.cpu) || 0, 100) + '%'
    els.statMemory.textContent = formatBytes(data.memory && data.memory.total ? data.memory.total - data.memory.free : 0) + ' used'
    els.statMemoryBar.style.width = Math.min((data.memory && data.memory.percentage) || 0, 100) + '%'
    els.statUptime.textContent = formatDuration(data.uptime || 0)
  }

  function onProcesses (processes) {
    state.processes = processes || []
    markConnected(els.pm2Version.textContent === 'Connecting...' ? 'Connected' : els.pm2Version.textContent)
    els.statProcesses.textContent = String(state.processes.length)
    renderProcessTable()
  }

  function renderProcessTable () {
    var colSpan = window.GUI.readonly ? 8 : 9
    var unmanaged = getUnmanagedSavedProjects()
    var totalRows = state.processes.length + unmanaged.length

    els.processCount.textContent = totalRows + ' app' + (totalRows === 1 ? '' : 's')

    if (!totalRows) {
      els.processList.innerHTML = '<tr><td colspan="' + colSpan + '"><div class="empty-state">No projects yet. Click <strong>Add project folder</strong> to add one without starting it.</div></td></tr>'
      return
    }

    var rows = state.processes.map(renderProcessRow).concat(unmanaged.map(renderSavedProjectRow))
    els.processList.innerHTML = rows.join('')
  }

  function renderProcessRow (proc) {
    var env = proc.pm2_env || {}
    var status = env.status || 'unknown'
    var mode = (env.exec_mode || '').replace(/_mode$/, '')
    var project = findProjectForProcess(proc)
    var pathHint = project ? project.path : (env.pm_cwd || '')
    var actions = window.GUI.readonly ? '' : (
      '<td class="row-actions">' +
        renderProcessActions(status, proc, project) +
      '</td>'
    )

    return (
      '<tr class="is-clickable" data-pmid="' + proc.pm_id + '">' +
        '<td><span class="status-badge ' + status + '"><span class="status-dot"></span>' + status + '</span></td>' +
        '<td>' + renderNameCell(proc.name || 'unknown', pathHint) + '</td>' +
        '<td>' + proc.pm_id + '</td>' +
        '<td><span class="mode-badge">' + escapeHtml(mode || 'fork') + '</span></td>' +
        '<td>' + formatPercent(proc.monit && proc.monit.cpu) + '</td>' +
        '<td>' + formatBytes(proc.monit && proc.monit.memory) + '</td>' +
        '<td>' + (env.restart_time || 0) + '</td>' +
        '<td>' + formatDuration(env.pm_uptime ? (Date.now() - env.pm_uptime) / 1000 : 0) + '</td>' +
        actions +
      '</tr>'
    )
  }

  function renderSavedProjectRow (project) {
    var entry = project.type === 'ecosystem'
      ? 'ecosystem config'
      : (project.script || 'index.js')
    var actions = window.GUI.readonly ? '' : (
      '<td class="row-actions">' +
        '<button class="btn btn-icon" data-project-start="' + project.id + '" title="start">▶</button>' +
        '<button class="btn btn-icon" data-project-delete="' + project.id + '" title="delete">✕</button>' +
      '</td>'
    )

    return (
      '<tr class="is-saved" data-project-id="' + project.id + '">' +
        '<td><span class="status-badge saved"><span class="status-dot"></span>saved</span></td>' +
        '<td>' + renderNameCell(project.name, project.path, entry) + '</td>' +
        '<td>—</td>' +
        '<td><span class="mode-badge">—</span></td>' +
        '<td>—</td>' +
        '<td>—</td>' +
        '<td>—</td>' +
        '<td>—</td>' +
        actions +
      '</tr>'
    )
  }

  function renderNameCell (name, pathHint, entry) {
    var html = '<strong>' + escapeHtml(name) + '</strong>'
    if (pathHint) {
      html += '<span class="process-path" title="' + escapeHtml(pathHint) + '">' + escapeHtml(pathHint) + '</span>'
    }
    if (entry) {
      html += '<span class="process-entry">Entry: ' + escapeHtml(entry) + '</span>'
    }
    return html
  }

  function renderProcessActions (status, proc, project) {
    var html = ''
    if (status === 'online') {
      var serviceUrl = resolveServiceUrl(proc, project)
      if (serviceUrl) {
        html += openServiceLink(serviceUrl)
      }
      html += actionButton('restart', proc.pm_id) + actionButton('stop', proc.pm_id) + actionButton('delete', proc.pm_id)
    } else {
      html += actionButton('start', proc.pm_id) + actionButton('delete', proc.pm_id)
    }
    return html
  }

  function getPublicHost () {
    var host = location.hostname
    if (window.GUI.publicHost && (!host || host === 'localhost' || host === '127.0.0.1')) {
      return window.GUI.publicHost
    }
    return host
  }

  function getPublicProtocol () {
    if (window.GUI.publicProtocol) {
      var protocol = String(window.GUI.publicProtocol).replace(/:$/, '')
      return protocol + ':'
    }
    return location.protocol || 'http:'
  }

  function extractPortFromEnv (env) {
    if (!env) {
      return null
    }
    var keys = ['PORT', 'port', 'HTTP_PORT', 'SERVER_PORT', 'APP_PORT', 'WEB_PORT', 'NODE_PORT']
    for (var i = 0; i < keys.length; i++) {
      if (env[keys[i]] != null && env[keys[i]] !== '') {
        var port = parseInt(env[keys[i]], 10)
        if (port > 0 && port < 65536) {
          return port
        }
      }
    }
    return null
  }

  function resolveServiceUrl (proc, project) {
    if (project && project.serviceUrl) {
      return project.serviceUrl
    }

    var port = (project && project.servicePort) || extractPortFromEnv(proc.pm2_env && proc.pm2_env.env)
    if (!port) {
      return null
    }

    var host = getPublicHost()
    if (!host) {
      return null
    }

    var path = (project && project.servicePath) || '/'
    if (path.charAt(0) !== '/') {
      path = '/' + path
    }

    return getPublicProtocol() + '//' + host + ':' + port + path
  }

  function openServiceLink (url) {
    return (
      '<a class="btn btn-icon btn-open" href="' + escapeAttr(url) + '" target="_blank" rel="noopener noreferrer" title="Open ' + escapeAttr(url) + '">↗</a>'
    )
  }

  function actionButton (action, id) {
    var labels = { start: '▶', restart: '↻', stop: '■', delete: '✕' }
    return '<button class="btn btn-icon" data-action="' + action + '" data-id="' + id + '" title="' + action + '">' + (labels[action] || action) + '</button>'
  }

  function runAction (action, id, button) {
    if (!state.sockets.sys || !state.sockets.sys.connected) {
      toast('Not connected to monitor.', 'error')
      return
    }
    if (button) {
      button.disabled = true
      setTimeout(function () { button.disabled = false }, 1200)
    }
    state.sockets.sys.emit(EVENTS.PULL_ACTION, action, id)
  }

  function loadSetupStatus () {
    fetch('/status_api', { credentials: 'same-origin' })
      .then(function (res) { return res.json() })
      .then(function (data) {
        state.setupData = data
        renderSetupStatus(data)
      })
      .catch(function () {
        if (els.setupStatus) {
          els.setupStatus.innerHTML = '<div class="setup-alert">Could not load setup status from the server.</div>'
        }
      })
  }

  function renderSetupStatus (data) {
    if (!els.setupSteps || !data) {
      return
    }

    var checks = [
      { ok: data.homeExists, label: 'PM2 home exists', detail: data.pm2Home },
      { ok: data.socketsExist, label: 'PM2 daemon is running', detail: data.socketsExist ? 'rpc.sock and pub.sock found' : 'Run `pm2 ls` to start the daemon' },
      { ok: data.pm2Connected, label: 'PM2 API reachable', detail: data.pm2Error || (data.pm2Version ? 'PM2 v' + data.pm2Version : 'Connected') }
    ]

    els.setupStatus.innerHTML = checks.map(function (item) {
      return '<div class="setup-check ' + (item.ok ? 'ok' : 'fail') + '"><strong>' + escapeHtml(item.label) + '</strong><span>' + escapeHtml(item.detail || '') + '</span></div>'
    }).join('')

    if (Array.isArray(data.steps)) {
      els.setupSteps.innerHTML = data.steps.map(function (step, index) {
        return (
          '<li class="' + (step.done ? 'done' : '') + '">' +
            '<span class="step-num">' + (index + 1) + '</span>' +
            '<div><strong>' + escapeHtml(step.title) + '</strong>' +
            '<code>' + escapeHtml(step.command) + '</code></div>' +
          '</li>'
        )
      }).join('')
    }
  }

  function showSetupModal (message) {
    if (!els.setupModal) {
      return
    }
    els.setupSummary.textContent = message || 'Additional setup is required before pm2-gui can connect to PM2.'
    els.setupModal.hidden = false
    loadSetupStatus()
  }

  function hideSetupModal () {
    if (els.setupModal) {
      els.setupModal.hidden = true
    }
  }

  function copySetupCommands () {
    var commands = [
      'npm install -g pm2',
      'pm2 ls',
      'cd /path/to/pm2-gui && npm install && npm start'
    ]
    if (state.setupData && Array.isArray(state.setupData.steps)) {
      commands = state.setupData.steps.map(function (step) { return step.command })
    }
    navigator.clipboard.writeText(commands.join('\n')).then(function () {
      toast('Setup commands copied to clipboard.')
    }).catch(function () {
      toast('Could not copy commands automatically.', 'error')
    })
  }

  function showFatal (message) {
    if (els.processList) {
      els.processList.innerHTML = '<tr><td colspan="9"><div class="empty-state">' + escapeHtml(message) + '</div></td></tr>'
    }
    showSetupModal(message)
  }

  function openProcessModal (pmId) {
    var proc = state.processes.find(function (p) { return p.pm_id === pmId })
    if (!proc) {
      return
    }

    state.selectedProc = proc
    els.modalTitle.textContent = proc.name || 'Process'
    els.modalSubtitle.textContent = 'ID ' + proc.pm_id + ' · PID ' + (proc.pid || '—')
    els.modalInfo.textContent = formatProcessInfo(proc)
    els.modalLog.textContent = 'Waiting for logs...'
    state.monitorData = []
    state.logAutoScroll = true
    els.modal.hidden = false
    switchTab('info')
    startLogTail(proc.pm_id)
    startMonitor(proc.pid)
  }

  function closeModal () {
    els.modal.hidden = true
    state.selectedProc = null
    closeLogSocket()
    stopMonitor()
  }

  function switchTab (tabName) {
    document.querySelectorAll('#process-modal .tab').forEach(function (tab) {
      tab.classList.toggle('active', tab.dataset.tab === tabName)
    })
    document.querySelectorAll('#process-modal .tab-panel').forEach(function (panel) {
      panel.classList.toggle('active', panel.id === 'tab-' + tabName)
    })

    if (tabName === 'monitor' && state.selectedProc) {
      drawMonitorChart()
    }
  }

  function formatProcessInfo (proc) {
    var env = proc.pm2_env || {}
    return [
      'name: ' + (proc.name || ''),
      'pm_id: ' + proc.pm_id,
      'pid: ' + (proc.pid || 0),
      'status: ' + (env.status || ''),
      'mode: ' + (env.exec_mode || ''),
      'restarts: ' + (env.restart_time || 0),
      'exec path: ' + (env.pm_exec_path || ''),
      'user: ' + (env.user || env.USER || ''),
      'created: ' + (env.created_at ? new Date(env.created_at).toLocaleString() : '—')
    ].join('\n')
  }

  function startLogTail (pmId) {
    closeLogSocket()
    state.sockets.log = connectSocket(getCurrentConnection(), NSP.LOG)
    state.sockets.log.on(EVENTS.CONNECT, function () {
      state.sockets.log.emit(EVENTS.PULL_LOGS, pmId, true)
    })
    state.sockets.log.on(EVENTS.DATA, function (payload) {
      if (!state.selectedProc || payload.id !== state.selectedProc.pm_id) {
        return
      }
      appendLog(payload.text || '')
    })
    state.sockets.log.on(EVENTS.ERROR, function (payload) {
      if (payload && payload.error) {
        appendLog(payload.error)
      }
    })
  }

  function closeLogSocket () {
    if (state.sockets.log) {
      state.sockets.log.emit(EVENTS.PULL_LOGS_END)
      state.sockets.log.disconnect()
      state.sockets.log = null
    }
  }

  function appendLog (text) {
    if (!text) {
      return
    }
    if (els.modalLog.textContent === 'Waiting for logs...') {
      els.modalLog.textContent = ''
    }
    els.modalLog.insertAdjacentHTML('beforeend', text + '\n')
    if (state.logAutoScroll) {
      els.modalLog.scrollTop = els.modalLog.scrollHeight
    }
  }

  function startMonitor (pid) {
    stopMonitor()
    if (!pid) {
      return
    }

    state.sockets.monitor = connectSocket(getCurrentConnection(), NSP.PROCESS)
    state.sockets.monitor.on(EVENTS.CONNECT, function () {
      state.sockets.monitor.emit(EVENTS.PULL_USAGE, pid)
    })
    state.sockets.monitor.on(EVENTS.DATA_USAGE, function (payload) {
      if (!state.selectedProc || payload.pid !== state.selectedProc.pid) {
        return
      }
      state.monitorData.push(payload)
      if (state.monitorData.length > 60) {
        state.monitorData.shift()
      }
      if (document.querySelector('#tab-monitor.active')) {
        drawMonitorChart()
      }
    })
  }

  function stopMonitor () {
    if (state.sockets.monitor) {
      state.sockets.monitor.disconnect()
      state.sockets.monitor = null
    }
    state.monitorData = []
  }

  function drawMonitorChart () {
    var canvas = els.monitorChart
    if (!canvas) {
      return
    }
    var ctx = canvas.getContext('2d')
    var width = canvas.width
    var height = canvas.height
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = '#0f172a'
    ctx.fillRect(0, 0, width, height)

    if (!state.monitorData.length) {
      ctx.fillStyle = '#64748b'
      ctx.font = '14px Inter, sans-serif'
      ctx.fillText('Collecting metrics...', 20, 40)
      return
    }

    var padding = 30
    var chartWidth = width - padding * 2
    var chartHeight = height - padding * 2

    function plotLine (key, color) {
      ctx.beginPath()
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      state.monitorData.forEach(function (point, index) {
        var x = padding + (index / Math.max(state.monitorData.length - 1, 1)) * chartWidth
        var value = key === 'cpu' ? (point.usage.cpu || 0) : (point.usage.memory || 0)
        var y = padding + chartHeight - (Math.min(value, 100) / 100) * chartHeight
        if (index === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      ctx.stroke()
    }

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.15)'
    for (var i = 0; i <= 4; i++) {
      var y = padding + (chartHeight / 4) * i
      ctx.beginPath()
      ctx.moveTo(padding, y)
      ctx.lineTo(width - padding, y)
      ctx.stroke()
    }

    plotLine('cpu', '#6366f1')
    plotLine('memory', '#22d3ee')
  }

  function getCurrentConnection () {
    if (els.agentSelect) {
      return els.agentSelect.value
    }
    return window.GUI.connections[window.GUI.connections.length - 1].value
  }

  function toast (message, type) {
    var node = document.createElement('div')
    node.className = 'toast' + (type ? ' ' + type : '')
    node.textContent = message
    els.toastContainer.appendChild(node)
    setTimeout(function () { node.remove() }, 5000)
  }

  function formatBytes (bytes) {
    bytes = Number(bytes) || 0
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB'
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB'
    return (bytes / 1073741824).toFixed(2) + ' GB'
  }

  function formatPercent (value) {
    return (Number(value) || 0).toFixed(1) + '%'
  }

  function formatDuration (seconds) {
    seconds = Math.max(0, Math.floor(Number(seconds) || 0))
    var days = Math.floor(seconds / 86400)
    var hours = Math.floor((seconds % 86400) / 3600)
    var minutes = Math.floor((seconds % 3600) / 60)
    var secs = seconds % 60
    if (days > 0) return days + 'd ' + hours + 'h'
    if (hours > 0) return hours + 'h ' + minutes + 'm'
    if (minutes > 0) return minutes + 'm ' + secs + 's'
    return secs + 's'
  }

  function showSettingsModal () {
    if (!els.settingsModal) return
    els.settingsModal.hidden = false
    switchSettingsTab('general')
    loadSettings()
  }

  function hideSettingsModal () {
    if (els.settingsModal) els.settingsModal.hidden = true
  }

  function switchSettingsTab (name) {
    document.querySelectorAll('#settings-tabs .tab').forEach(function (tab) {
      tab.classList.toggle('active', tab.dataset.settingsTab === name)
    })
    document.querySelectorAll('#settings-modal .settings-body .tab-panel').forEach(function (panel) {
      panel.classList.toggle('active', panel.id === 'settings-tab-' + name)
    })
  }

  function loadSettings () {
    fetch('/settings_api', {
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' }
    })
      .then(parseApiResponse)
      .then(function (result) {
        if (!result.ok) throw new Error(result.body.error || 'Could not load settings')
        fillSettingsForm(result.body)
      })
      .catch(function (err) {
        toast(err.message, 'error')
      })
  }

  function fillSettingsForm (data) {
    var s = data.settings || {}
    var a = data.auth || {}
    var t = data.telegram || {}

    setVal('setting-public-host', s.public_host || '')
    setVal('setting-public-protocol', s.public_protocol || 'http')
    setVal('setting-refresh', s.refresh || '5s')
    setVal('setting-process-refresh', s.process_refresh || '3s')
    setChecked('setting-readonly', !!s.readonly)

    setChecked('setting-auth-enabled', !!a.enabled)
    setChecked('setting-require-2fa', !!a.require2fa)
    setVal('setting-session-hours', a.sessionTimeoutHours || 24)
    setVal('setting-max-attempts', a.maxLoginAttempts || 5)
    setVal('setting-lockout', a.lockoutMinutes || 15)

    setChecked('setting-tg-enabled', !!t.enabled)
    setVal('setting-tg-token', t.botToken || '')
    setVal('setting-tg-chat', t.chatId || '')
    setChecked('setting-tg-restart', t.notifyRestart !== false)
    setChecked('setting-tg-error', t.notifyError !== false)
    setChecked('setting-tg-stop', t.notifyStop !== false)
    setChecked('setting-tg-exit', t.notifyExit !== false)
    setChecked('setting-tg-online', !!t.notifyOnline)

    var hint = document.getElementById('settings-data-dir')
    if (hint) {
      hint.textContent = 'Database: ' + (data.dbPath || '—')
    }

    var list = document.getElementById('settings-user-list')
    if (list) {
      list.innerHTML = (data.users || []).map(function (u) {
        return '<li><span><strong>' + escapeHtml(u.username) + '</strong>' +
          (u.totpEnabled ? ' · 2FA on' : ' · 2FA off') +
          '</span></li>'
      }).join('') || '<li><span>No users yet</span></li>'
    }

    window.GUI.publicHost = s.public_host || ''
    window.GUI.publicProtocol = s.public_protocol || 'http'
    if (data.startup) {
      state.startup = data.startup
    }
    renderStartupPanel(state.startup)
  }

  function renderStartupPanel (startup) {
    var statusEl = document.getElementById('startup-status-text')
    var metaEl = document.getElementById('startup-meta')
    var stepsEl = document.getElementById('startup-instructions')
    if (!statusEl) return

    if (!startup || startup.error) {
      statusEl.textContent = (startup && startup.error) || 'Could not load startup status.'
      return
    }

    if (metaEl) {
      metaEl.innerHTML =
        '<div class="startup-kv"><span>App dir</span><code>' + escapeHtml(startup.appDir || '') + '</code></div>' +
        '<div class="startup-kv"><span>User home</span><code>' + escapeHtml(startup.userHome || '') + '</code></div>' +
        '<div class="startup-kv"><span>User</span><code>' + escapeHtml(startup.owner || '') + '</code></div>' +
        '<div class="startup-kv"><span>Command</span><code id="startup-command">' + escapeHtml(startup.command || '') + '</code></div>' +
        '<div class="startup-kv"><span>Script</span><code>' + escapeHtml(startup.scriptPath || '') + '</code></div>'
    }

    setVal('setting-startup-app-dir', startup.appDir || '')
    setVal('setting-startup-user-home', startup.userHome || '')

    if (startup.warning) {
      statusEl.textContent = startup.warning
    } else if (startup.existingTask) {
      statusEl.textContent = 'Boot task already exists in Task Scheduler ("' + startup.taskName + '", id ' + startup.existingTask.id + ').'
    } else if (startup.bootEnabled) {
      statusEl.textContent = 'Boot start was configured earlier via ' + (startup.lastMethod || 'an automated method') + '.'
    } else if (startup.synology) {
      statusEl.textContent = 'Synology detected. You can try automatic creation, or follow the manual steps.'
    } else {
      statusEl.textContent = 'Not running on Synology. Set Synology paths below only if you will copy the script to the NAS; prefer generating it on the NAS.'
    }

    if (stepsEl && startup.instructions && Array.isArray(startup.instructions.steps)) {
      stepsEl.innerHTML = startup.instructions.steps.map(function (step, index) {
        return '<li><span class="step-num">' + (index + 1) + '</span><div><strong>' + escapeHtml(step) + '</strong></div></li>'
      }).join('')
    }
  }

  function createStartupTask () {
    var btn = document.getElementById('setting-startup-create')
    var resultEl = document.getElementById('startup-result')
    if (btn) {
      btn.disabled = true
      btn.textContent = 'Creating…'
    }
    fetch('/settings_api/startup', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        appDir: getVal('setting-startup-app-dir').trim(),
        userHome: getVal('setting-startup-user-home').trim()
      })
    })
      .then(parseApiResponse)
      .then(function (result) {
        if (!result.ok) throw new Error(result.body.error || 'Could not create boot task')
        if (resultEl) {
          resultEl.hidden = false
          if (result.body.ok) {
            resultEl.className = 'startup-result ok'
            resultEl.textContent = 'Boot start configured via ' + (result.body.method || 'automation') +
              (result.body.note ? '. ' + result.body.note : '')
            toast('Boot start configured')
          } else {
            resultEl.className = 'startup-result fail'
            resultEl.textContent = (result.body.error || result.body.note || 'Automatic creation failed.') +
              ' Follow the manual steps below.'
            toast(result.body.error || 'Automatic creation failed — see manual steps', 'error')
          }
        }
        loadSettings()
      })
      .catch(function (err) {
        if (resultEl) {
          resultEl.hidden = false
          resultEl.className = 'startup-result fail'
          resultEl.textContent = err.message
        }
        toast(err.message, 'error')
      })
      .finally(function () {
        if (btn) {
          btn.disabled = false
          btn.textContent = 'Create / update boot task'
        }
      })
  }

  function copyStartupCommand () {
    var commandEl = document.getElementById('startup-command')
    var command = commandEl ? commandEl.textContent : (state.startup && state.startup.command) || ''
    if (!command) {
      toast('No command available yet.', 'error')
      return
    }
    navigator.clipboard.writeText(command).then(function () {
      toast('Boot command copied')
    }).catch(function () {
      toast('Could not copy automatically.', 'error')
    })
  }

  function setVal (id, value) {
    var el = document.getElementById(id)
    if (el) el.value = value
  }

  function setChecked (id, value) {
    var el = document.getElementById(id)
    if (el) el.checked = !!value
  }

  function getVal (id) {
    var el = document.getElementById(id)
    return el ? el.value : ''
  }

  function getChecked (id) {
    var el = document.getElementById(id)
    return !!(el && el.checked)
  }

  function parseApiResponse (res) {
    return res.text().then(function (text) {
      var body = null
      var raw = text || ''
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch (err) {
        var snippet = raw.replace(/\s+/g, ' ').slice(0, 120)
        throw new Error(
          'Server returned non-JSON (HTTP ' + res.status + '). ' +
          'Restart pm2-gui so the settings API is loaded. ' +
          (snippet ? 'Got: ' + snippet : '')
        )
      }
      return { ok: res.ok, status: res.status, body: body }
    })
  }

  function saveSettings () {
    var payload = {
      settings: {
        public_host: getVal('setting-public-host').trim(),
        public_protocol: getVal('setting-public-protocol'),
        refresh: getVal('setting-refresh').trim() || '5s',
        process_refresh: getVal('setting-process-refresh').trim() || '3s',
        readonly: getChecked('setting-readonly')
      },
      auth: {
        enabled: getChecked('setting-auth-enabled'),
        require2fa: getChecked('setting-require-2fa'),
        sessionTimeoutHours: parseInt(getVal('setting-session-hours'), 10) || 24,
        maxLoginAttempts: parseInt(getVal('setting-max-attempts'), 10) || 5,
        lockoutMinutes: parseInt(getVal('setting-lockout'), 10) || 15
      },
      telegram: {
        enabled: getChecked('setting-tg-enabled'),
        botToken: getVal('setting-tg-token').trim(),
        chatId: getVal('setting-tg-chat').trim(),
        notifyRestart: getChecked('setting-tg-restart'),
        notifyError: getChecked('setting-tg-error'),
        notifyStop: getChecked('setting-tg-stop'),
        notifyExit: getChecked('setting-tg-exit'),
        notifyOnline: getChecked('setting-tg-online')
      }
    }

    fetch('/settings_api/save', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(parseApiResponse)
      .then(function (result) {
        if (!result.ok) throw new Error(result.body.error || 'Could not save settings')
        fillSettingsForm(result.body)
        toast('Settings saved')
        if (payload.settings.readonly !== window.GUI.readonly) {
          toast('Read-only mode change applies after reload')
        }
      })
      .catch(function (err) {
        toast(err.message, 'error')
      })
  }

  function createSettingsUser () {
    fetch('/settings_api/users', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: getVal('setting-new-username').trim(),
        password: getVal('setting-new-password')
      })
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body } }) })
      .then(function (result) {
        if (!result.ok) throw new Error(result.body.error || 'Could not create user')
        setVal('setting-new-username', '')
        setVal('setting-new-password', '')
        toast('User created')
        loadSettings()
      })
      .catch(function (err) {
        toast(err.message, 'error')
      })
  }

  function testTelegram () {
    fetch('/settings_api/telegram/test', {
      method: 'POST',
      credentials: 'same-origin'
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body } }) })
      .then(function (result) {
        if (!result.ok) throw new Error(result.body.error || 'Telegram test failed')
        toast('Test message sent')
      })
      .catch(function (err) {
        toast(err.message, 'error')
      })
  }

  function changeSettingsPassword () {
    fetch('/settings_api/password', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentPassword: getVal('setting-cur-password'),
        newPassword: getVal('setting-new-password')
      })
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body } }) })
      .then(function (result) {
        if (!result.ok) throw new Error(result.body.error || 'Could not change password')
        setVal('setting-cur-password', '')
        setVal('setting-new-password', '')
        toast('Password updated')
      })
      .catch(function (err) {
        toast(err.message, 'error')
      })
  }

  function begin2faSetup () {
    fetch('/settings_api/2fa/begin', {
      method: 'POST',
      credentials: 'same-origin'
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body } }) })
      .then(function (result) {
        if (!result.ok) throw new Error(result.body.error || 'Could not start 2FA setup')
        var setup = document.getElementById('settings-2fa-setup')
        var qr = document.getElementById('setting-2fa-qr')
        var secret = document.getElementById('setting-2fa-secret')
        if (setup) setup.hidden = false
        if (qr) qr.src = result.body.qrDataUrl
        if (secret) secret.textContent = 'Secret: ' + result.body.secret
      })
      .catch(function (err) {
        toast(err.message, 'error')
      })
  }

  function confirm2faSetup () {
    fetch('/settings_api/2fa/confirm', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: getVal('setting-2fa-code') })
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body } }) })
      .then(function (result) {
        if (!result.ok) throw new Error(result.body.error || 'Could not confirm 2FA')
        toast('2FA enabled')
        var setup = document.getElementById('settings-2fa-setup')
        if (setup) setup.hidden = true
        loadSettings()
      })
      .catch(function (err) {
        toast(err.message, 'error')
      })
  }

  function disable2fa () {
    var password = window.prompt('Enter your password to disable 2FA')
    if (password == null) return
    var code = window.prompt('Enter a current 2FA code')
    if (code == null) return
    fetch('/settings_api/2fa/disable', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password, code: code })
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body } }) })
      .then(function (result) {
        if (!result.ok) throw new Error(result.body.error || 'Could not disable 2FA')
        toast('2FA disabled')
        loadSettings()
      })
      .catch(function (err) {
        toast(err.message, 'error')
      })
  }

  function logout () {
    fetch('/auth_api/logout', {
      method: 'POST',
      credentials: 'same-origin'
    }).finally(function () {
      window.location.href = '/auth'
    })
  }

  function escapeHtml (value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function escapeAttr (value) {
    return escapeHtml(value)
  }
})()
