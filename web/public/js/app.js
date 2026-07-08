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
    browsingFolder: false
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
      savedProjectsList: document.getElementById('saved-projects-list'),
      savedCount: document.getElementById('saved-count'),
      addProjectBtn: document.getElementById('add-project-btn'),
      startProjectsBtn: document.getElementById('start-projects-btn')
    }
  }

  function bindUI () {
    document.body.addEventListener('click', function (event) {
      var target = event.target

      if (target.dataset.close === 'setup') {
        hideSetupModal()
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

      if (target.id === 'setup-copy') {
        copySetupCommands()
        return
      }

      if (target.id === 'add-project-btn') {
        browseProjectFolder()
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

      if (target.dataset.action && !window.GUI.readonly) {
        var id = target.dataset.id
        var action = target.dataset.action
        if (action === 'delete' && id !== 'all' && !confirm('Delete process ' + id + '?')) {
          return
        }
        if (action === 'delete' && id === 'all' && !confirm('Delete ALL processes?')) {
          return
        }
        runAction(action, id, target)
        return
      }

      var row = target.closest('[data-pmid]')
      if (row && row.dataset.pmid !== undefined) {
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
      onVersion: function (version) {
        markConnected('PM2 v' + version)
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
    if (!els.savedProjectsList) {
      return
    }

    state.projectsLoading = true
    fetch('/projects_api', { credentials: 'same-origin' })
      .then(function (res) { return res.json() })
      .then(function (data) {
        state.savedProjects = data.projects || []
        renderSavedProjects(data.dataDir)
      })
      .catch(function (err) {
        toast('Could not load saved project folders.', 'error')
      })
      .finally(function () {
        state.projectsLoading = false
      })
  }

  function renderSavedProjects (dataDir) {
    if (!els.savedProjectsList) {
      return
    }

    els.savedCount.textContent = state.savedProjects.length + ' saved'

    if (!state.savedProjects.length) {
      els.savedProjectsList.innerHTML = '<div class="empty-state">No saved folders yet. Click “Add project folder” to pick one.</div>'
      return
    }

    els.savedProjectsList.innerHTML = state.savedProjects.map(function (project) {
      var entry = project.type === 'ecosystem'
        ? 'ecosystem config'
        : (project.script || 'index.js')
      var actions = window.GUI.readonly ? '' : (
        '<div class="saved-project-actions">' +
          '<button class="btn btn-secondary" data-project-start="' + project.id + '">Start</button>' +
          '<button class="btn btn-icon" data-project-remove="' + project.id + '" title="Remove">✕</button>' +
        '</div>'
      )

      return (
        '<div class="saved-project-card">' +
          '<div class="saved-project-main">' +
            '<strong>' + escapeHtml(project.name) + '</strong>' +
            '<span class="saved-project-path" title="' + escapeHtml(project.path) + '">' + escapeHtml(project.path) + '</span>' +
            '<span class="saved-project-meta">Entry: ' + escapeHtml(entry) + (dataDir ? '' : '') + '</span>' +
          '</div>' +
          actions +
        '</div>'
      )
    }).join('')
  }

  function browseProjectFolder () {
    if (window.GUI.readonly || state.browsingFolder) {
      return
    }

    state.browsingFolder = true
    if (els.addProjectBtn) {
      els.addProjectBtn.disabled = true
      els.addProjectBtn.textContent = 'Choose a folder…'
    }

    fetch('/projects_api/browse', {
      method: 'POST',
      credentials: 'same-origin'
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body } }) })
      .then(function (result) {
        if (!result.ok) {
          throw new Error(result.body.error || 'Could not add project folder')
        }
        if (result.body.canceled) {
          return
        }
        toast('Saved project folder: ' + result.body.project.name)
        loadSavedProjects()
        if (state.sockets.process && state.sockets.process.connected) {
          state.sockets.process.emit(EVENTS.PULL_PROCESSES)
        }
      })
      .catch(function (err) {
        toast(err.message, 'error')
      })
      .finally(function () {
        state.browsingFolder = false
        if (els.addProjectBtn) {
          els.addProjectBtn.disabled = false
          els.addProjectBtn.textContent = 'Add project folder'
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
    if (!confirm('Remove this saved folder from your list?')) {
      return
    }
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
    els.processCount.textContent = state.processes.length + ' app' + (state.processes.length === 1 ? '' : 's')
    renderProcessTable()
  }

  function renderProcessTable () {
    if (!state.processes.length) {
      els.processList.innerHTML = '<tr><td colspan="' + (window.GUI.readonly ? 8 : 9) + '"><div class="empty-state">No processes running. Start apps with <code>pm2 start app.js</code>.</div></td></tr>'
      return
    }

    els.processList.innerHTML = state.processes.map(function (proc) {
      var env = proc.pm2_env || {}
      var status = env.status || 'unknown'
      var mode = (env.exec_mode || '').replace(/_mode$/, '')
      var actions = window.GUI.readonly ? '' : (
        '<td class="row-actions">' +
          actionButton('restart', proc.pm_id) +
          (status === 'online' ? actionButton('stop', proc.pm_id) : '') +
          actionButton('delete', proc.pm_id) +
        '</td>'
      )

      return (
        '<tr class="is-clickable" data-pmid="' + proc.pm_id + '">' +
          '<td><span class="status-badge ' + status + '"><span class="status-dot"></span>' + status + '</span></td>' +
          '<td><strong>' + escapeHtml(proc.name || 'unknown') + '</strong></td>' +
          '<td>' + proc.pm_id + '</td>' +
          '<td><span class="mode-badge">' + escapeHtml(mode || 'fork') + '</span></td>' +
          '<td>' + formatPercent(proc.monit && proc.monit.cpu) + '</td>' +
          '<td>' + formatBytes(proc.monit && proc.monit.memory) + '</td>' +
          '<td>' + (env.restart_time || 0) + '</td>' +
          '<td>' + formatDuration(env.pm_uptime ? (Date.now() - env.pm_uptime) / 1000 : 0) + '</td>' +
          actions +
        '</tr>'
      )
    }).join('')
  }

  function actionButton (action, id) {
    var labels = { restart: '↻', stop: '■', delete: '✕' }
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

  function escapeHtml (value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }
})()
