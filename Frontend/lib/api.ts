// Typed-ish client for the EDGECASE FastAPI backend (Backend/). All responses use {success, data, meta, error}.
import { useEffect, useState } from 'react'

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000').replace(/\/$/, '')

export class ApiError extends Error {
  code: string
  constructor(message: string, code = 'ERROR') {
    super(message)
    this.code = code
  }
}

export type Envelope<T = any> = { data: T; meta?: Record<string, any> }

async function call<T = any>(path: string, init: RequestInit = {}): Promise<Envelope<T>> {
  const isForm = typeof FormData !== 'undefined' && init.body instanceof FormData
  let res: Response
  try {
    res = await fetch(`${API_URL}/api/v1${path}`, {
      ...init,
      headers: isForm ? init.headers : { 'Content-Type': 'application/json', ...(init.headers || {}) },
    })
  } catch {
    throw new ApiError(`Cannot reach the API at ${API_URL}. Is the backend running?`, 'NETWORK')
  }
  const json = await res.json().catch(() => null)
  if (!res.ok || !json?.success) throw new ApiError(json?.error?.message || `Request failed (${res.status})`, json?.error?.code)
  return { data: json.data, meta: json.meta }
}

const post = <T = any>(path: string, body: unknown = {}) => call<T>(path, { method: 'POST', body: JSON.stringify(body) })
const q = (params: Record<string, string | number | undefined>) =>
  Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')

export const api = {
  policies: () => call<any[]>('/policies'),
  overview: (policySlug: string, simulationId?: string) => call('/dashboard/overview?' + q({ policySlug, simulationId })),
  runSimulation: (policySlug: string, mode: string, populationSize = 100000) => post('/simulations', { policySlug, mode, populationSize }),
  cases: (simId: string, filter: string, search: string) => call<any[]>(`/simulations/${simId}/cases?` + q({ filter, q: search, pageSize: 50 })),
  cliffs: (simId: string) => call<any[]>(`/simulations/${simId}/cliffs`),
  conflicts: (simId: string) => call<any[]>(`/simulations/${simId}/conflicts`),
  fairness: (simId: string) => call(`/simulations/${simId}/fairness`),
  whatIf: (body: { simulationId: string; parameter?: string; newValue?: number; scenario?: string; explain?: boolean }) => post('/what-if', body),
  chat: (message: string, simulationId?: string) => post<{ reply: string }>('/chat', { message, simulationId }),
  extractText: (text: string) => post('/policies/extract-text', { text }),
  extractPdf: (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return call('/policies/extract-pdf', { method: 'POST', body: fd })
  },
  confirmRules: (slug: string) => post(`/policies/${slug}/confirm-rules`),
  createReport: (simulationId: string, reportType: string) => post('/reports', { simulationId, reportType }),
  reports: (policySlug: string) => call<any[]>('/reports?' + q({ policySlug })),
}

export const reportUrl = (rep: { downloadUrl: string }, inline = false) => `${API_URL}${rep.downloadUrl}${inline ? '?inline=true' : ''}`
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong')

/** Runs `load` whenever `deps` change; ignores stale responses. Pass null to stay idle. */
export function useApi<T = any>(load: (() => Promise<Envelope<T>>) | null, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; meta: Record<string, any> | null; error: string; loading: boolean }>({
    data: null, meta: null, error: '', loading: !!load,
  })
  useEffect(() => {
    if (!load) return
    let live = true
    setState(s => ({ ...s, loading: true, error: '' }))
    load()
      .then(r => live && setState({ data: r.data, meta: r.meta ?? null, error: '', loading: false }))
      .catch(e => live && setState({ data: null, meta: null, error: errMsg(e), loading: false }))
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return state
}

export function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}
