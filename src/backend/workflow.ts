import type { PluginBackendApi, PluginBackendOperationContext } from '@valley/plugin-sdk'
import { registerWorkflowContribution, type WorkflowContributionContract, type WorkflowExecutionRequest, type WorkflowContributionRegistrationOptions } from '@valley/plugin-sdk/workflow'
import config from '../../config.json'

type Handler = (input: unknown, context: PluginBackendOperationContext) => unknown | Promise<unknown>
type Binding = { method: string; constants?: Record<string, unknown>; inputProperty?: string; result?: string; wrap: boolean; effect: string }
const bindings: Record<string, Binding> = {
  "playback.snapshot": {
    "method": "command.playback.snapshot",
    "wrap": false,
    "effect": "read"
  },
  "playback.resume": {
    "method": "command.playback.action",
    "wrap": false,
    "effect": "execute",
    "constants": {
      "type": "resume"
    }
  },
  "playback.toggle": {
    "method": "command.playback.action",
    "wrap": false,
    "effect": "execute",
    "constants": {
      "type": "toggle"
    }
  },
  "playback.pause": {
    "method": "command.playback.action",
    "wrap": false,
    "effect": "execute",
    "constants": {
      "type": "pause"
    }
  },
  "playback.next": {
    "method": "command.playback.action",
    "wrap": false,
    "effect": "execute",
    "constants": {
      "type": "next"
    }
  },
  "playback.previous": {
    "method": "command.playback.action",
    "wrap": false,
    "effect": "execute",
    "constants": {
      "type": "previous"
    }
  },
  "playback.clear": {
    "method": "command.playback.action",
    "wrap": false,
    "effect": "execute",
    "constants": {
      "type": "clear"
    }
  },
  "playback.stop": {
    "method": "command.playback.action",
    "wrap": false,
    "effect": "execute",
    "constants": {
      "type": "stop"
    }
  },
  "playback.repeat": {
    "method": "command.playback.action",
    "wrap": false,
    "effect": "execute",
    "constants": {
      "type": "repeat"
    }
  },
  "playback.shuffle": {
    "method": "command.playback.action",
    "wrap": false,
    "effect": "execute",
    "constants": {
      "type": "shuffle"
    }
  },
  "playback.flush": {
    "method": "command.playback.action",
    "wrap": false,
    "effect": "execute",
    "constants": {
      "type": "flush"
    }
  },
  "playback.start": {
    "method": "command.playback.action",
    "wrap": false,
    "effect": "execute",
    "constants": {
      "type": "start"
    }
  },
  "playback.seek": {
    "method": "command.playback.action",
    "wrap": false,
    "effect": "execute",
    "constants": {
      "type": "seek"
    }
  },
  "playback.volume": {
    "method": "command.playback.action",
    "wrap": false,
    "effect": "execute",
    "constants": {
      "type": "volume"
    }
  },
  "playback.add": {
    "method": "command.playback.action",
    "wrap": false,
    "effect": "execute",
    "constants": {
      "type": "add"
    }
  },
  "playback.remove": {
    "method": "command.playback.action",
    "wrap": false,
    "effect": "execute",
    "constants": {
      "type": "remove"
    }
  },
  "playback.playQueued": {
    "method": "command.playback.action",
    "wrap": false,
    "effect": "execute",
    "constants": {
      "type": "playQueued"
    }
  },
  "playback.reorder": {
    "method": "command.playback.action",
    "wrap": false,
    "effect": "execute",
    "constants": {
      "type": "reorder"
    }
  },
  "library.list": {
    "method": "command.library.list",
    "wrap": false,
    "effect": "read"
  },
  "track.read": {
    "method": "command.track.read",
    "wrap": false,
    "effect": "read"
  },
  "track.update": {
    "method": "command.track.update",
    "wrap": false,
    "effect": "write"
  },
  "track.delete": {
    "method": "command.track.delete",
    "wrap": false,
    "effect": "write"
  },
  "playlist.read": {
    "method": "command.playlist.read",
    "wrap": false,
    "effect": "read"
  },
  "playlist.create": {
    "method": "command.playlist.create",
    "wrap": false,
    "effect": "write"
  },
  "playlist.update": {
    "method": "command.playlist.update",
    "wrap": false,
    "effect": "write"
  },
  "playlist.delete": {
    "method": "command.playlist.delete",
    "wrap": false,
    "effect": "write"
  },
  "library.rescan": {
    "method": "command.library.rescan",
    "wrap": false,
    "effect": "write"
  },
  "artist.read": {
    "method": "command.artist.read",
    "wrap": false,
    "effect": "read"
  },
  "artist.update": {
    "method": "command.artist.update",
    "wrap": false,
    "effect": "write"
  },
  "artist.rename": {
    "method": "command.artist.rename",
    "wrap": false,
    "effect": "write"
  },
  "artist.merge": {
    "method": "command.artist.merge",
    "wrap": false,
    "effect": "write"
  }
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))

export async function executeWorkflowOperation(binding: Binding, handler: Handler, request: WorkflowExecutionRequest, context: PluginBackendOperationContext) {
  context.cancellation.throwIfAborted()
  const input = binding.inputProperty ? { ...binding.constants, [binding.inputProperty]: request.parameters } : { ...request.parameters, ...binding.constants }
  let value: unknown
  try { value = await handler(input, context) }
  catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    const details = failure as Error & { fatal?: boolean; transient?: boolean; retryable?: boolean; outcome?: string; outcomeUnknown?: boolean }
    const unknown = details.outcome === 'unknown' || details.outcomeUnknown === true || binding.effect === 'execute' && details.outcome !== 'not-applied'
    if (details.fatal === undefined) details.fatal = true
    if (details.transient === undefined) details.transient = false
    if (details.retryable === undefined || unknown || details.fatal) details.retryable = false
    if (unknown) { details.outcome = 'unknown'; details.outcomeUnknown = true }
    throw failure
  }
  if (binding.result === 'driver') {
    if (!object(value) || value.ok !== true) {
      const unknown = object(value) && (value.outcome === 'unknown' || value.outcome === 'remote-complete') || binding.effect === 'execute' && !(object(value) && value.outcome === 'not-applied')
      throw Object.assign(new Error(object(value) && typeof value.error === 'string' ? value.error : 'Provider operation failed'), { code: object(value) && typeof value.code === 'string' ? value.code : 'PROVIDER_FAILED', fatal: true, transient: false, retryable: false, ...(unknown ? { outcome: 'unknown', outcomeUnknown: true } : {}) })
    }
    value = value.data ?? null
  } else if (binding.result === 'command') {
    if (!object(value) || !Object.hasOwn(value, 'value')) throw Object.assign(new Error('Provider receipt has no confirmed value'), { code: 'PROVIDER_INVALID_RESULT', outcome: 'unknown', outcomeUnknown: true, fatal: true, transient: false, retryable: false })
    value = value.value
  }
  const json = binding.wrap ? { value: value ?? null } : value
  if (!object(json)) throw Object.assign(new Error('Provider result is not a JSON object'), { code: 'PROVIDER_INVALID_RESULT', outcome: 'unknown', outcomeUnknown: true, fatal: true, transient: false, retryable: false })
  return { items: [{ json: JSON.parse(JSON.stringify(json)) as Record<string, unknown>, ...(request.items.length ? { pairedItem: { itemIndex: 0 } } : {}) }] }
}

export function createWorkflowAdapter(api: PluginBackendApi, options: WorkflowContributionRegistrationOptions = {}) {
  const handlers = new Map<string, Handler>()
  const operation: PluginBackendApi['rpc']['handleOperation'] = (method, handler) => {
    handlers.set(method, handler)
    const off = api.rpc.handleOperation(method, handler)
    return () => { if (handlers.get(method) === handler) handlers.delete(method); off() }
  }
  const local = (method: string, handler: Handler) => { handlers.set(method, handler); return () => { if (handlers.get(method) === handler) handlers.delete(method) } }
  const run = (method: string, input: unknown, context: PluginBackendOperationContext) => {
    const handler = handlers.get(method)
    if (!handler) throw Object.assign(new Error('Workflow backend operation is unavailable'), { code: 'PROVIDER_UNAVAILABLE', fatal: true, transient: false, retryable: false })
    return handler(input, context)
  }
  const contract = (config.runtime.services as unknown as Array<{ id: string; metadata?: { workflow?: WorkflowContributionContract } }>).find(service => service.id === 'workflow.provider')!.metadata!.workflow!
  const contribution = registerWorkflowContribution(api, contract, (request, context) => {
    const binding = bindings[request.nodeTypeId]
    if (!binding) throw new Error('Unknown registered Workflow block')
    return executeWorkflowOperation(binding, (input, scoped) => run(binding.method, input, scoped), request, context)
  }, options)
  void contribution.ready.catch(error => api.rpc.emit?.('workflow.registrationFailed', { message: error instanceof Error ? error.message : String(error) }))
  return { operation, local, run, ready: contribution.ready, dispose: contribution.dispose, emit: contribution.emit }
}
