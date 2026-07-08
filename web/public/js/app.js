'use strict'

(function () {
  var NSP = {
    SYS: '/system',
    LOG: '/log',
    PROCESS: '/proccess'
  }

  var EVENTS = {
    ERROR: 'error',
    CONNECT: 'connect',
    CONNECT_ERROR: 'connect_error',
    DATA: 'data',
    DATA_PROCESSES: 'data.processes',
    DATA_SYSTEM_STATS: 'data.sysstat',
    DATA_PM2_VERSION: 'data.pm2version',
    DATA_ACTION: 'data.action',
    DATA_USAGE: 'data.usage',
    PULL_LOGS: 'pull.log',
    PULL_LOGS_END: 'pull.log_end',
    PULL_USAGE: 'pull.usage',
    PULL_ACTION: 'pull.action'
  }

  var state = {
    sysStat: null,
    processes: [],
    sockets: {},
    selectedProc: null,
    monitorData: [],
    monitorTimer: null,
    logAutoScroll: true
  }

  var els = {}

  document.addEventListener('DOMContentLoaded', init)

  function init () {
    cacheElements()
    bindUI()

    if (!Array.isArray(window.GUI.connections) || window.GUI.connections.length === 0) {
      toast('No agent is online.', 'error')
      return
    }

    var connection = window.GUI.connections[window.GUI.connections.length - 1]
    var select = els.agentSelect
    if (select) {
      select.addEventListener('change', function () {
        reconnect(select.value)
      })
      connection = window.GUI.connections.find(function (c) {
        return c.value === select.value
      }) || connection
    }

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
      agentSelect: document.getElementById('agent-select')
    }
  }

  function bindUI () {
    document.body.addEventListener('click', function (event) {
      var target = event.target

      if (target.dataset.close === 'modal') {
        closeModal()
        return
      }

      if (target.dataset.tab) {
        switchTab(target.dataset.tab)
        return
      }

      if (target.dataset.action && !window.GUI.readonly) {
        var id = target.dataset.id
        var action = target.dataset.action
        if (action === 'delete' && !confirm('Delete process ' + id + '?')) {
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
    state.sockets.sys = connectSocket(connectionValue, NSP.SYS)
    state.sockets.process = connectSocket(connectionValue, NSP.PROCESS)

    state.sockets.sys.on(EVENTS.DATA_SYSTEM_STATS, onSystemStats)
    state.sockets.sys.on(EVENTS.DATA_PM2_VERSION, function (version) {
      els.pm2Version.textContent = 'PM2 v' + version
    })
    state.sockets.sys.on(EVENTS.DATA_ACTION, function (payload) {
      if (payload && payload.error) {
        toast(payload.error, 'error')
      }
    })
    state.sockets.sys.on(EVENTS.ERROR, onSocketError)
    state.sockets.sys.on(EVENTS.CONNECT_ERROR, onSocketError)

    state.sockets.process.on(EVENTS.DATA_PROCESSES, onProcesses)
    state.sockets.process.on(EVENTS.ERROR, onSocketError)
    state.sockets.process.on(EVENTS.CONNECT_ERROR, onSocketError)
  }

  function reconnect (connectionValue) {
    connectAll(connectionValue)
  }

  function disconnectAll () {
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
    if (uri.indexOf('localhost') >= 0 || /127\.0\.0\.1/.test(uri)) {
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
      forceNew: true,
      timeout: 5000,
      reconnection: true
    })
  }

  function onSocketError (err) {
    var message = typeof err === 'string' ? err : (err && err.message) || 'Connection error'
    if (message === 'unauthorized') {
      message = 'Authentication failed. Check your authorization token.'
    }
    toast(message, 'error')
  }

  function onSystemStats (data) {
    state.sysStat = data
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
    els.statProcesses.textContent = String(state.processes.length)
    els.processCount.textContent = state.processes.length + ' app' + (state.processes.length === 1 ? '' : 's')
    renderProcessTable()
  }

  function renderProcessTable () {
    if (!state.processes.length) {
      els.processList.innerHTML = '<tr><td colspan="' + (window.GUI.readonly ? 8 : 9) + '"><div class="empty-state">No processes running. Start apps with <code>pm2 start</code>.</div></td></tr>'
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
    if (!state.sockets.sys) {
      return
    }
    if (button) {
      button.disabled = true
      setTimeout(function () { button.disabled = false }, 1200)
    }
    state.sockets.sys.emit(EVENTS.PULL_ACTION, action, id)
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
    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.classList.toggle('active', tab.dataset.tab === tabName)
    })
    document.querySelectorAll('.tab-panel').forEach(function (panel) {
      panel.classList.toggle('active', panel.id === 'tab-' + tabName)
    })

    if (tabName === 'monitor' && state.selectedProc) {
      drawMonitorChart()
    }
  }

  function formatProcessInfo (proc) {
    var env = proc.pm2_env || {}
    var lines = [
      'name: ' + (proc.name || ''),
      'pm_id: ' + proc.pm_id,
      'pid: ' + (proc.pid || 0),
      'status: ' + (env.status || ''),
      'mode: ' + (env.exec_mode || ''),
      'restarts: ' + (env.restart_time || 0),
      'exec path: ' + (env.pm_exec_path || ''),
      'script: ' + (env.pm_cwd || '') + '/' + (env.name || ''),
      'user: ' + (env.user || env.USER || ''),
      'created: ' + (env.created_at ? new Date(env.created_at).toLocaleString() : '—')
    ]
    return lines.join('\n')
  }

  function startLogTail (pmId) {
    closeLogSocket()
    var connection = getCurrentConnection()
    state.sockets.log = connectSocket(connection, NSP.LOG)

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

    var connection = getCurrentConnection()
    state.sockets.monitor = connectSocket(connection, NSP.PROCESS)
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
        if (index === 0) {
          ctx.moveTo(x, y)
        } else {
          ctx.lineTo(x, y)
        }
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
    setTimeout(function () {
      node.remove()
    }, 5000)
  }

  function formatBytes (bytes) {
    bytes = Number(bytes) || 0
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB'
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB'
    return (bytes / 1073741824).toFixed(2) + ' GB'
  }

  function formatPercent (value) {
    value = Number(value) || 0
    return value.toFixed(1) + '%'
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
