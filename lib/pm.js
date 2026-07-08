'use strict'

var pm2 = require('pm2')
var _ = require('lodash')
var async = require('async')

var pm = module.exports = {}

var allowedEvents = ['start', 'restart', 'exit', 'online', 'stop']
var connected = false
var connectOptions = null

function ensureConnected (options, fn) {
  if (connected) {
    return fn(null)
  }

  var opts = {}
  if (options && options.pm2Home) {
    opts.pm2_home = options.pm2Home
  }

  connectOptions = opts
  pm2.connect(Object.keys(opts).length ? opts : undefined, function (err) {
    if (err) {
      return fn(err)
    }
    connected = true
    fn(null)
  })
}

/**
 * Subscribe to PM2 event bus.
 * @param {Object} options
 * @param {Function} fn process event callback
 * @returns {Object} bus handle with close()
 */
pm.sub = function (options, fn) {
  options = options || {}
  var bus = null
  var closed = false

  ensureConnected(options, function (err) {
    if (err) {
      console.error('pm2 connect error:', err.message)
      return
    }

    pm2.launchBus(function (err, launchedBus) {
      if (err) {
        console.error('pm2 bus error:', err.message)
        return
      }

      bus = launchedBus

      bus.on('process:event', function (data) {
        if (data && data.event && allowedEvents.indexOf(data.event) >= 0) {
          fn.call(options.context, data)
        }
      })
    })
  })

  return {
    close: function () {
      if (closed || !bus) {
        return
      }
      closed = true
      try {
        bus.close()
      } catch (err) {}
    },
    on: function (event, handler) {
      if (!bus) {
        var self = this
        setTimeout(function retry () {
          if (bus) {
            bus.on(event, handler)
          } else if (!closed) {
            setTimeout(retry, 50)
          }
        }, 50)
        return
      }
      bus.on(event, handler)
    },
    off: function (event, handler) {
      if (bus) {
        bus.off(event, handler)
      }
    }
  }
}

/**
 * Disconnect from PM2 daemon.
 */
pm.disconnect = function () {
  if (connected) {
    pm2.disconnect()
    connected = false
    connectOptions = null
  }
}

/**
 * Get PM2 version.
 * @param {Object|String} options pm2Home or socketPath (legacy)
 * @param {Function} fn
 */
pm.version = function (options, fn) {
  if (_.isString(options) || _.isFunction(options)) {
    fn = options
    options = {}
  }
  if (_.isFunction(fn) && !options) {
    var tmp = fn
    fn = tmp
    options = {}
  }

  ensureConnected(options, function (err) {
    if (err) {
      return fn(err)
    }
    pm2.getVersion(fn)
  })
}

/**
 * List available processes.
 * @param {Object} options
 * @param {Function} fn
 */
pm.list = function (options, fn) {
  if (_.isFunction(options)) {
    fn = options
    options = {}
  }
  options = options || {}

  ensureConnected(options, function (err) {
    if (err) {
      return fn(err, [])
    }
    pm2.list(function (err, procs) {
      fn(err, procs || [])
    })
  })
}

/**
 * Trigger actions on process by pm_id.
 * @param {Object} options
 * @param {Function} fn
 */
pm.action = function (options, fn) {
  options = options || {}
  var action = options.action

  if (options.id === 'all') {
    return pm.list(options, function (err, procs) {
      if (err) {
        return fn(err)
      }
      if (!procs || procs.length === 0) {
        return fn(new Error('No PM2 process is running!'))
      }

      if (action === 'save') {
        return pm2.dump(fn)
      }

      async.map(procs, function (proc, next) {
        pm._actionByPMId({
          process: proc,
          action: action
        }, next.bind(null, null))
      }, fn)
    })
  }

  pm._findById(options, function (err, proc) {
    if (err) {
      return fn(err)
    }
    pm._actionByPMId({
      process: proc,
      action: action
    }, fn)
  })
}

/**
 * Find process by pm_id.
 * @private
 */
pm._findById = function (options, fn) {
  pm.list(options, function (err, procs) {
    if (err) {
      return fn(err)
    }
    if (!procs || procs.length === 0) {
      return fn(new Error('No PM2 process running. Make sure PM2 is running (`pm2 ls`).'))
    }

    var id = parseInt(options.id, 10)
    var proc = _.find(procs, function (p) {
      return p && p.pm_id === id
    })

    if (!proc) {
      return fn(new Error('Cannot find pm process by pm_id: ' + options.id))
    }

    fn(null, proc)
  })
}

/**
 * Execute action on a single process.
 * @private
 */
pm._actionByPMId = function (options, fn) {
  var pmId = options.process.pm_id
  var action = options.action
  var noBusEvent = action === 'delete' && options.process.pm2_env.status !== 'online'

  ensureConnected(options, function (err) {
    if (err) {
      return fn(err)
    }

    console.debug('[pm:' + pmId + ']', action)

    if (action === 'save') {
      return pm2.dump(function (err) {
        fn(err, noBusEvent)
      })
    }

    var handler = pm2[action]
    if (!handler) {
      return fn(new Error('Unsupported action: ' + action))
    }

    handler.call(pm2, pmId, function (err) {
      fn(err, noBusEvent)
    })
  })
}
