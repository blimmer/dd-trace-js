'use strict'

const platform = require('../../platform')
const log = require('../../log')
const Config = require('../../config')
const tracerVersion = require('../../../lib/version')

const MAX_SIZE = 8 * 1024 * 1024 // 8MB
const METRIC_PREFIX = 'datadog.tracer.node.exporter.agent'
const ARRAY_OF_TWO_EMPTY_ARRAYS = Buffer.from([0x92, 0x90, 0x90])

class Writer {
  constructor (url, prioritySampler, lookup) {
    this._url = url
    this._prioritySampler = prioritySampler
    this._lookup = lookup
    this._appends = []
    this._needsFlush = false

    this._config = new Config({})

    getProtocolVersion(this)
  }

  get length () {
    return this._count
  }

  append (spans) {
    this._hasAppended = true
    if (this._protocolVersion) {
      log.debug(() => `Encoding trace: ${JSON.stringify(spans)}`)

      this._encode(spans)
    } else {
      this._appends.push(spans)
    }
  }

  _sendPayload (data, count) {
    platform.metrics().increment(`${METRIC_PREFIX}.requests`, true)

    makeRequest(this._protocolVersion, data, count, this._url, this._lookup, true, (err, res, status) => {
      if (status) {
        platform.metrics().increment(`${METRIC_PREFIX}.responses`, true)
        platform.metrics().increment(`${METRIC_PREFIX}.responses.by.status`, `status:${status}`, true)
      } else if (err) {
        platform.metrics().increment(`${METRIC_PREFIX}.errors`, true)
        platform.metrics().increment(`${METRIC_PREFIX}.errors.by.name`, `name:${err.name}`, true)

        if (err.code) {
          platform.metrics().increment(`${METRIC_PREFIX}.errors.by.code`, `code:${err.code}`, true)
        }
      }

      platform.startupLog.startupLog({ agentError: err })

      if (err) return log.error(err)

      log.debug(`Response from the agent: ${res}`)

      try {
        this._prioritySampler.update(JSON.parse(res).rate_by_service)
      } catch (e) {
        log.error(e)

        platform.metrics().increment(`${METRIC_PREFIX}.errors`, true)
        platform.metrics().increment(`${METRIC_PREFIX}.errors.by.name`, `name:${e.name}`, true)
      }
    })
  }

  _encode (trace) {
    const offset = this._offset
    try {
      this._offset = this._encoderForVersion.encode(this._buffer, this._offset, trace, this)
      this._count++
    } catch (e) {
      if (e instanceof RangeError) {
        log.error(e.message)
      } else {
        throw e
      }
    }

    log.debug(() => [
      'Added encoded trace to buffer:',
      this._buffer.slice(offset, this._offset).toString('hex').match(/../g).join(' ')
    ].join(' '))
  }

  _reset () {
    this._buffer = Buffer.allocUnsafe(MAX_SIZE)
    this._offset = 5 // we'll use these first bytes to hold an array prefix
    this._count = 0

    this._encoderForVersion.init()
  }

  flush () {
    if (this._protocolVersion) {
      if (this._count > 0) {
        const traceData = platform.msgpack.prefix(this._buffer.slice(0, this._offset), this._count)
        const data = this._encoderForVersion.makePayload(traceData)

        this._sendPayload(data, this._count)

        this._reset()
      }
    } else {
      this._needsFlush = true
    }
  }
}

function setHeader (headers, key, value) {
  if (value) {
    headers[key] = value
  }
}

function getProtocolVersion (writer) {
  const config = writer._config
  if (config.protocolVersion) {
    if (config.protocolVersion.match(/^v?0\.4/)) {
      writer._protocolVersion = 'v0.4'
      writer._encoderForVersion = require('../../encode/0.4')
    } else {
      writer._protocolVersion = 'v0.5'
      writer._encoderForVersion = require('../../encode/0.5')
    }
    writer._reset()
    return
  }

  function cb (err, res, status) {
    if (status === 404) {
      writer._protocolVersion = 'v0.4'
      writer._encoderForVersion = require('../../encode/0.4')
    } else if (status === 200) {
      writer._protocolVersion = 'v0.5'
      writer._encoderForVersion = require('../../encode/0.5')
    } else {
      // Drop any traces already appended, so that we're not endlessly storing traces we can't send.
      writer._appends.length = 0
      writer._needsFlush = false
      setTimeout(() => getProtocolVersion(writer), 500)
      return
    }

    writer._reset()

    for (const spans of writer._appends) {
      writer.append(spans)
    }
    if (writer._needsFlush) {
      writer.flush()
    }

    // Clear everything so it's not being stored in memory forever.
    writer._appends.length = 0
    writer._needsFlush = false
  }

  setImmediate(() => makeRequest(
    'v0.5',
    [ARRAY_OF_TWO_EMPTY_ARRAYS],
    '0',
    writer._url,
    writer._lookup,
    !!writer._appends.length,
    cb))
}

function makeRequest (version, data, count, url, lookup, needsStartupLog, cb) {
  const options = {
    path: `/${version}/traces`,
    method: 'PUT',
    headers: {
      'Content-Type': 'application/msgpack',
      'Datadog-Meta-Tracer-Version': tracerVersion,
      'X-Datadog-Trace-Count': String(count)
    },
    lookup
  }

  setHeader(options.headers, 'Datadog-Meta-Lang', platform.name())
  setHeader(options.headers, 'Datadog-Meta-Lang-Version', platform.version())
  setHeader(options.headers, 'Datadog-Meta-Lang-Interpreter', platform.engine())

  if (url.protocol === 'unix:') {
    options.socketPath = url.pathname
  } else {
    options.protocol = url.protocol
    options.hostname = url.hostname
    options.port = url.port
  }

  log.debug(() => `Request to the agent: ${JSON.stringify(options)}`)

  platform.request(Object.assign({ data }, options), (err, res, status) => {
    if (needsStartupLog) {
      // Note that logging will only happen once, regardless of how many times this is called.
      platform.startupLog.startupLog({
        agentError: status !== 404 && status !== 200 ? err : undefined
      })
    }
    cb(err, res, status)
  })
}

module.exports = Writer
