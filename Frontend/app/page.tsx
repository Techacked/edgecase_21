'use client'

import { useEffect, useState } from 'react'
import {
  ArrowRight, BarChart3, Check, ChevronDown, ChevronRight, CircleDot, ClipboardCheck, FileText, FlaskConical,
  GitBranch, LayoutDashboard, Menu, Play, Plus, Search, Settings2, SlidersHorizontal, Sparkles, Target, Upload, X, Zap,
} from 'lucide-react'
import { api, errMsg, reportUrl, useApi, useDebounced } from '@/lib/api'

type Page = 'Overview' | 'Policy Lab' | 'Simulation' | 'What-If Lab' | 'Reports'
type SimTab = 'Overview' | 'Edge Cases' | 'Cliffs' | 'Conflicts' | 'Fairness'
type CaseFilter = 'all' | 'eligible' | 'rejected' | 'edge'
type Mode = 'STRESS_TEST' | 'BOUNDARY_SCAN' | 'FAIRNESS_AUDIT'
type Api = { data: any; error: string; loading: boolean }
type Ctx = { ov: Api; retry: () => void; slug: string; simId?: string; policy: any }

const DEFAULT_SLUG = 'scholarship-eligibility'
const MODES: Mode[] = ['STRESS_TEST', 'BOUNDARY_SCAN', 'FAIRNESS_AUDIT']
const MODE_LABEL: Record<Mode, string> = { STRESS_TEST: 'Stress Test', BOUNDARY_SCAN: 'Boundary Scan', FAIRNESS_AUDIT: 'Fairness Audit' }
const num = (x: number) => (x ?? 0).toLocaleString('en-US')
const pad2 = (x: number) => String(x ?? 0).padStart(2, '0')

const navItems: { label: Page; icon: typeof LayoutDashboard }[] = [
  { label: 'Overview', icon: LayoutDashboard },
  { label: 'Policy Lab', icon: FlaskConical },
  { label: 'Simulation', icon: BarChart3 },
  { label: 'What-If Lab', icon: SlidersHorizontal },
  { label: 'Reports', icon: FileText },
]

function StatusPill({ children, tone = 'sage' }: { children: React.ReactNode; tone?: 'sage' | 'muted' | 'earth' }) {
  return <span className={`status-pill ${tone}`}><span className="status-dot" />{children}</span>
}

function MetricCard({ label, value, note, accent = false, onClick }: { label: string; value: string; note?: string; accent?: boolean; onClick?: () => void }) {
  const content = <><span className="eyebrow">{label}</span><strong>{value}</strong>{note && <span className="metric-note">{note}</span>}</>
  return onClick
    ? <button type="button" className={`metric-card metric-card-button ${accent ? 'accent-card' : ''}`} onClick={onClick}>{content}<span className="metric-card-hint">View cases <ArrowRight size={12} /></span></button>
    : <div className={`metric-card ${accent ? 'accent-card' : ''}`}>{content}</div>
}

function SectionHeader({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: React.ReactNode }) {
  return <div className="section-header"> <div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2></div>{children}</div>
}

function Loading({ label = 'LOADING FROM ENGINE' }: { label?: string }) { return <div className="loading-state">{label}</div> }
function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="api-error" role="alert"><span>{message}</span>{onRetry && <button type="button" onClick={onRetry}>RETRY</button>}</div>
}
/** Shows loading / error / children once overview data is ready. */
function Gate({ ctx, children }: { ctx: Ctx; children: (ov: any) => React.ReactNode }) {
  if (ctx.ov.error) return <ErrorBox message={ctx.ov.error} onRetry={ctx.retry} />
  if (!ctx.ov.data) return <Loading />
  return <>{children(ctx.ov.data)}</>
}

/* ───────────────────────── Overview ───────────────────────── */
function Overview({ ctx, setPage }: { ctx: Ctx; setPage: (page: Page) => void }) {
  return <div className="page-content overview-page">
    <div className="hero-grid">
      <div className="hero-copy"><span className="eyebrow sage-text">POLICY INTELLIGENCE / 01</span><h1>Find the people<br /><em>between the rules.</em></h1><p>EDGECASE turns policy language into executable rules, then stress-tests them against synthetic populations to reveal what conventional analysis misses.</p><div className="hero-actions"><button className="button primary" onClick={() => setPage('Policy Lab')}>Test a Policy <ArrowRight size={16} /></button><button className="button secondary" onClick={() => setPage('Simulation')}>View Demo <Play size={15} /></button></div></div>
      <div className="pipeline-card"><div className="pipeline-top"><span className="eyebrow">THE CRASH-TEST PIPELINE</span><span className="live-mark"><CircleDot size={12} /> LIVE ENGINE</span></div><div className="pipeline-list">{['POLICY INPUT', 'AI RULE EXTRACTION', 'CONSTRAINT ENGINE', 'SYNTHETIC POPULATION', 'STRESS TEST', 'EDGE CASES'].map((item, i) => <div className="pipeline-item" key={item}><span className={`pipeline-number ${i === 5 ? 'last' : ''}`}>0{i + 1}</span><span>{item}</span>{i < 5 && <ChevronRight size={15} className="pipeline-arrow" />}</div>)}</div></div>
    </div>
    <div className="simulated-banner"><Sparkles size={14} /> ALL INSIGHTS ON THIS PAGE ARE GENERATED FROM SYNTHETIC DEMO DATA <span>NOT FOR REAL-WORLD DECISION MAKING</span></div>
    <Gate ctx={ctx}>{ov => {
      const r = ov.simulation.results
      return <>
        <SectionHeader eyebrow={`CURRENT RUN / ${ov.policy.name.toUpperCase()}`} title="A policy health snapshot"><button className="text-button" onClick={() => setPage('Simulation')}>Open full simulation <ArrowRight size={15} /></button></SectionHeader>
        <div className="metrics-grid">
          <MetricCard label="Synthetic Cases Tested" value={num(r.totalTested)} note={`SEED ${ov.simulation.seed} · ${ov.simulation.mode.replace('_', ' ')}`} />
          <MetricCard label="Edge Cases Found" value={num(r.edgeCaseCount)} note={`${r.edgeCaseRate}% of population`} accent />
          <MetricCard label="Policy Cliffs" value={pad2(r.cliffCount)} note={`${r.cliffHighCount} high severity`} />
          <MetricCard label="Rule Conflicts" value={pad2(r.conflictCount)} note={`${r.conflictUnresolved} unresolved`} />
        </div>
        <div className="lower-grid">
          <div className="panel health-panel"><SectionHeader title="Policy health"><span className="panel-caption">LAST RUN · {ov.lastRun}</span></SectionHeader><div className="health-list">{ov.health.map((h: any) => <div className="health-row" key={h.name}><span>{h.name}</span><div className="health-track"><i style={{ width: `${h.width}%` }} /></div><strong>{h.value}</strong><span className="health-state">{h.state}</span></div>)}</div></div>
          <div className="panel insight-panel"><span className="eyebrow sage-text">{ov.insight.code}</span><h3>{ov.insight.headline}</h3><p>{ov.insight.body}</p><button className="button dark-button" onClick={() => setPage('What-If Lab')}>Explore the cliff <ArrowRight size={15} /></button></div>
        </div>
      </>
    }}</Gate>
  </div>
}

/* ───────────────────────── Policy Lab ───────────────────────── */
function PolicyLab({ ctx, policies, selectPolicy, refreshPolicies, setPage }: { ctx: Ctx; policies: any[]; selectPolicy: (s: string) => void; refreshPolicies: () => void; setPage: (p: Page) => void }) {
  const policy = ctx.policy
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [uploadedFile, setUploadedFile] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const adopt = (res: any) => { refreshPolicies(); selectPolicy(res.data.policy.slug) }
  const submitText = async () => {
    setBusy('text'); setError('')
    try { adopt(await api.extractText(pasteText)); setPasteOpen(false); setPasteText(''); setUploadedFile('') }
    catch (e) { setError(errMsg(e)) } finally { setBusy('') }
  }
  const submitPdf = async (file: File) => {
    setBusy('pdf'); setError(''); setUploadedFile(file.name)
    try { adopt(await api.extractPdf(file)) } catch (e) { setError(errMsg(e)); setUploadedFile('') } finally { setBusy('') }
  }
  const confirm = async () => {
    setBusy('confirm'); setError('')
    try { await api.confirmRules(ctx.slug); refreshPolicies(); setPage('Simulation') } catch (e) { setError(errMsg(e)) } finally { setBusy('') }
  }

  const version = policy?.currentVersion
  const rules: any[] = version?.rules ?? []
  const verified = rules.filter(r => r.verificationStatus === 'VERIFIED').length
  const docLines: string[] = version ? String(version.documentText || '').split('\n').filter((l: string) => l.trim()) : []
  const body = version?.sourceType === 'DEMO' ? docLines.slice(2) : docLines

  return <div className="page-content"><div className="page-intro"><div><span className="eyebrow sage-text">POLICY WORKSPACE / 02</span><h1>Policy Lab</h1><p>Turn policy language into executable rules.</p></div><StatusPill>{busy ? 'AI ENGINE WORKING' : 'AI ENGINE READY'}</StatusPill></div>
    <div className="policy-toolbar"><div><span className="eyebrow">ACTIVE POLICY</span><div className="select-wrap"><select value={ctx.slug} onChange={e => selectPolicy(e.target.value)}>{policies.map(p => <option key={p.slug} value={p.slug}>{p.name}</option>)}</select><ChevronDown size={16} /></div></div>
      <div className="toolbar-actions">
        <label className="button secondary file-button"><Upload size={15} /> {busy === 'pdf' ? 'Reading PDF…' : uploadedFile || 'Upload Policy PDF'}<input type="file" accept="application/pdf,.pdf" onChange={event => { const file = event.target.files?.[0]; if (file) submitPdf(file); event.target.value = '' }} /></label>
        <button className="button secondary" onClick={() => setPasteOpen(true)}><Plus size={15} /> Paste Policy Text</button>
        <button className="button primary" onClick={() => { selectPolicy(DEFAULT_SLUG); setUploadedFile('') }}>Use Demo Policy</button>
      </div></div>
    {error && <ErrorBox message={error} />}
    {pasteOpen && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Paste policy text"><div className="paste-modal panel"><div className="section-header"><div><span className="eyebrow sage-text">POLICY INPUT</span><h2>Paste policy text</h2></div><button type="button" className="icon-button" onClick={() => setPasteOpen(false)} aria-label="Close paste editor"><X size={17} /></button></div><p className="panel-desc">Paste the policy language below. EDGECASE will extract executable rules from it.</p><textarea autoFocus value={pasteText} onChange={event => setPasteText(event.target.value)} placeholder="e.g. Family income must not exceed ₹4,50,000. Applicant must have a CGPA of at least 6.5." aria-label="Policy text editor" />{error && <p className="inline-note">{error}</p>}<div className="modal-actions"><button type="button" className="button secondary" onClick={() => setPasteOpen(false)}>Cancel</button><button type="button" className="button primary" onClick={submitText} disabled={pasteText.trim().length < 20 || busy === 'text'}>{busy === 'text' ? 'Extracting…' : 'Use this policy text'} <ArrowRight size={15} /></button></div></div></div>}
    {!version ? <Loading /> : <div className="lab-grid">
      <div className="document-panel panel"><div className="panel-heading"><span><FileText size={16} /> Policy Document</span><span className="doc-meta">{version.sourceType === 'DEMO' ? 'DEMO_POLICY_2026.TXT' : `${version.sourceType} INPUT`}</span></div>
        <div className="document-copy"><p className="doc-title">{policy.name}</p><p className="doc-subtitle">{policy.authority}</p><hr />
          {body.map((line, i) => { const m = line.match(/^(\d+)[.)]\s+(.*)$/); return <p key={i}>{m ? <><b>{m[1]}.</b> {m[2]}</> : line}</p> })}
        </div>
        <div className="document-footer">PAGE 01 / 01 <span>{version.ocrConfidence ? `OCR CONFIDENCE ${version.ocrConfidence}%` : 'TEXT LAYER'}</span></div></div>
      <div className="rules-panel"><div className="panel-heading"><span><Zap size={16} /> AI Rule Extraction</span><StatusPill>{verified} VERIFIED</StatusPill></div>
        <div className="rules-stack">{rules.map((r, i) => <div className={`rule-card ${r.enabled ? '' : 'off'}`} key={r.id}><div className="rule-top"><span className="rule-id">RULE #{String(i + 1).padStart(2, '0')}</span><StatusPill>{r.verificationStatus === 'VERIFIED' ? 'VERIFIED' : 'NEEDS REVIEW'}</StatusPill></div><h3>{r.description}</h3><div className="rule-details"><span><b>TYPE</b> {r.type.charAt(0) + r.type.slice(1).toLowerCase()}</span><span><b>CONFIDENCE</b> {Math.round(r.confidence)}%</span></div><div className="formal-rule"><span>FORMAL CONSTRAINT</span><code>{r.normalizedConstraint}</code></div><button className="expand-rule" onClick={() => setPage('Simulation')}>View dependencies & conflicts <ChevronRight size={14} /></button></div>)}</div>
        <button className="button primary continue-button" onClick={confirm} disabled={busy === 'confirm'}>{busy === 'confirm' ? 'Confirming…' : 'Confirm Rules & Continue'} <ArrowRight size={15} /></button></div>
    </div>}
  </div>
}

/* ───────────────────────── Simulation ───────────────────────── */
function Simulation({ ctx, setPage, onNewSim }: { ctx: Ctx; setPage: (p: Page) => void; onNewSim: (id: string) => void }) {
  const [tab, setTab] = useState<SimTab>('Overview')
  const [selected, setSelected] = useState<any>(null)
  const [caseFilter, setCaseFilter] = useState<CaseFilter>('all')
  const [isRunning, setIsRunning] = useState(false)
  const [runError, setRunError] = useState('')
  const [mode, setMode] = useState<Mode>('STRESS_TEST')
  const showCases = (filter: CaseFilter) => { setCaseFilter(filter); setTab('Edge Cases') }
  const runSimulation = async () => {
    setIsRunning(true); setRunError('')
    try { const res = await api.runSimulation(ctx.slug, mode); onNewSim(res.data.id) } catch (e) { setRunError(errMsg(e)) } finally { setIsRunning(false) }
  }
  const cycleMode = () => setMode(m => MODES[(MODES.indexOf(m) + 1) % MODES.length])
  const tabs: SimTab[] = ['Overview', 'Edge Cases', 'Cliffs', 'Conflicts', 'Fairness']
  const ov = ctx.ov.data
  const r = ov?.simulation.results
  const simId: string | undefined = ov?.simulation.id
  return <div className="page-content"><div className="page-intro"><div><span className="eyebrow sage-text">ANALYSIS WORKSPACE / 03</span><h1>Simulation Engine</h1><p>Crash-test <strong>{ov?.policy.name ?? ctx.policy?.name ?? '…'}</strong> against a synthetic population.</p></div><StatusPill>{isRunning ? 'ENGINE RUNNING' : 'SIMULATED DATA'}</StatusPill></div>
    <div className="simulation-controls panel"><div><span className="eyebrow">SYNTHETIC POPULATION</span><strong className="control-value">{r ? num(r.totalTested) : '100,000'}</strong></div><div className="control-divider" /><div><span className="eyebrow">SIMULATION MODE</span><button type="button" className="mode-select" onClick={cycleMode} aria-label="Change simulation mode">{MODE_LABEL[mode]} <ChevronDown size={14} /></button></div><button className="button primary run-button" onClick={runSimulation} disabled={isRunning}><Play size={14} fill="currentColor" /> {isRunning ? 'Running...' : 'Run Simulation'}</button><span className="run-time">{isRunning ? 'PROCESSING...' : `LAST RUN ${ov?.lastRun ?? '--:--'}`}<br /><b>{isRunning ? 'CALCULATING' : ov ? 'COMPLETED' : 'LOADING'}</b></span></div>
    {runError && <ErrorBox message={runError} />}
    <Gate ctx={ctx}>{() => <>
      <div className="metrics-grid six"><MetricCard label="Cases tested" value={num(r.totalTested)} note={ov.simulation.mode.replace('_', ' ')} onClick={() => showCases('all')} /><MetricCard label="Eligible" value={num(r.eligibleCount)} note={`${r.eligibleRate}% coverage`} accent onClick={() => showCases('eligible')} /><MetricCard label="Rejected" value={num(r.rejectedCount)} note={`${r.rejectedRate}% of cases`} onClick={() => showCases('rejected')} /><MetricCard label="Edge cases" value={num(r.edgeCaseCount)} note={`${r.edgeCaseRate}% of cases`} onClick={() => showCases('edge')} /><MetricCard label="Policy cliffs" value={pad2(r.cliffCount)} note={`${r.cliffHighCount} high severity`} onClick={() => setTab('Cliffs')} /><MetricCard label="Rule conflicts" value={pad2(r.conflictCount)} note={`${r.conflictUnresolved} unresolved`} onClick={() => setTab('Conflicts')} /></div>
      <div className="tabs-bar">{tabs.map(item => <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item}{item === 'Edge Cases' && <span>{num(r.edgeCaseCount)}</span>}{item === 'Cliffs' && <span>{pad2(r.cliffCount)}</span>}{item === 'Conflicts' && <span>{pad2(r.conflictCount)}</span>}</button>)}</div>
      {tab === 'Overview' && <SimulationOverview r={r} setPage={setPage} onSearch={() => showCases('all')} />}
      {tab === 'Edge Cases' && <EdgeCases simId={simId!} onSelect={setSelected} filter={caseFilter} />}
      {tab === 'Cliffs' && <Cliffs simId={simId!} />}
      {tab === 'Conflicts' && <Conflicts simId={simId!} />}
      {tab === 'Fairness' && <Fairness simId={simId!} />}
    </>}</Gate>
    {selected && <CaseDrawer c={selected} onClose={() => setSelected(null)} />}
  </div>
}

function SimulationOverview({ r, setPage, onSearch }: { r: any; setPage: (p: Page) => void; onSearch: () => void }) {
  const e = r.eligibleRate, rj = r.rejectedRate
  return <div className="results-grid"><div className="panel chart-panel"><SectionHeader title="Eligibility distribution"><div className="overview-search" role="search"><Search size={15} /><input aria-label="Search simulation cases" placeholder="Search cases" onFocus={onSearch} onKeyDown={ev => { if (ev.key === 'Enter') onSearch() }} /></div></SectionHeader><div className="donut-wrap"><div className="donut" style={{ background: `conic-gradient(var(--sage) 0 ${e}%, #d8cdbf ${e}% ${e + rj}%, #bfc5b5 ${e + rj}%)` }}><div><strong>{e}%</strong><span>eligible</span></div></div><div className="legend"><span><i className="sage-dot" /> Eligible <b>{num(r.eligibleCount)}</b></span><span><i className="beige-dot" /> Rejected <b>{num(r.rejectedCount)}</b></span><span><i className="gray-dot" /> Needs review <b>{num(r.needsReviewCount)}</b></span></div></div></div>
    <div className="panel chart-panel"><SectionHeader title="Rejection reasons"><span className="panel-caption">TOP {pad2(r.rejectionReasons.length)}</span></SectionHeader><div className="bar-list">{r.rejectionReasons.map((x: any) => <div className="bar-row" key={x.reason}><div><span>{x.reason}</span><b>{num(x.count)}</b></div><div className="bar-track"><i style={{ width: `${x.percentage}%` }} /></div></div>)}{r.rejectionReasons.length === 0 && <p className="empty-state">No rejections in this run.</p>}</div></div>
    {r.anomalyHeadline && <div className="panel insight-panel result-insight"><span className="eyebrow sage-text">DETECTED ANOMALY</span><h3>{r.anomalyHeadline}</h3><p>{r.anomalyDescription}</p><button className="text-button" onClick={() => setPage('What-If Lab')}>Model a threshold change <ArrowRight size={15} /></button></div>}
  </div>
}

function EdgeCases({ simId, onSelect, filter = 'all' }: { simId: string; onSelect: (c: any) => void; filter?: CaseFilter }) {
  const [query, setQuery] = useState('')
  const [activeFilter, setActiveFilter] = useState<CaseFilter>(filter)
  useEffect(() => setActiveFilter(filter), [filter])
  const dq = useDebounced(query, 250)
  const cases = useApi(() => api.cases(simId, activeFilter, dq), [simId, activeFilter, dq])
  const cycleFilter = () => setActiveFilter(c => c === 'all' ? 'rejected' : c === 'rejected' ? 'eligible' : c === 'eligible' ? 'edge' : 'all')
  const title = activeFilter === 'rejected' ? 'Rejected cases' : activeFilter === 'eligible' ? 'Eligible cases' : activeFilter === 'edge' ? 'Edge cases' : 'All simulation cases'
  const rows: any[] = cases.data ?? []
  return <div className="panel table-panel"><SectionHeader title={title}><div className="table-tools"><Search size={15} /><input aria-label="Search cases" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search cases" /><button type="button" className="button secondary small-button" onClick={cycleFilter} aria-label={`Filter cases, currently ${activeFilter}`}><Settings2 size={14} /> {activeFilter === 'all' ? 'Filter' : activeFilter}</button></div></SectionHeader>
    {cases.error && <ErrorBox message={cases.error} />}
    <div className="table-scroll"><table><thead><tr><th>CASE ID</th><th>KEY ATTRIBUTES</th><th>RESULT</th><th>REASON</th><th>IMPACT</th><th>TYPE</th></tr></thead><tbody>{rows.map(c => <tr key={c.id} onClick={() => onSelect(c)}><td><b>{c.caseIdentifier}</b><small>SYNTHETIC DEMO CASE</small></td><td>{c.attributeSummary}</td><td><span className={`result-tag ${c.result.toLowerCase()}`}>{c.result}</span></td><td>{c.reason}</td><td>{c.severity}</td><td><span className="type-tag">{c.type.replace('_', ' ')}</span></td></tr>)}</tbody></table></div>
    {cases.loading && rows.length === 0 && <Loading label="LOADING CASES" />}
    {!cases.loading && !cases.error && rows.length === 0 && <p className="empty-state">No simulation cases match &quot;{query}&quot;.</p>}
    {cases.meta && rows.length > 0 && <p className="empty-state">Showing {rows.length} of {num(cases.meta.total)} cases{cases.meta.truncated && activeFilter === 'edge' ? ` (top ${num(cases.meta.total)} stored; ${num(cases.meta.edgeCaseCount)} edge cases total)` : ''}.</p>}
  </div>
}

function CaseDrawer({ c, onClose }: { c: any; onClose: () => void }) {
  return <div className="drawer-backdrop" onClick={onClose}><aside className="case-drawer" role="dialog" aria-modal="true" aria-label={`Case ${c.caseIdentifier}`} onClick={e => e.stopPropagation()}>
    <div className="drawer-header"><div><span className="eyebrow sage-text">SYNTHETIC CASE</span><h2>{c.caseIdentifier}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close case details"><X size={17} /></button></div>
    <div className="drawer-header" style={{ margin: 0 }}><span className={`result-tag ${c.result.toLowerCase()}`}>{c.result}</span><span className="type-tag">{c.type.replace('_', ' ')}</span></div>
    <div className="case-attrs">{Object.entries(c.attributes).map(([k, v]) => <div key={k}><span>{k.replace(/_/g, ' ').toUpperCase()}</span><strong>{typeof v === 'boolean' ? (v ? 'Yes' : 'No') : typeof v === 'number' ? v.toLocaleString('en-IN') : String(v)}</strong></div>)}</div>
    <div className="drawer-section"><span className="eyebrow">REASON</span><p>{c.reason}</p>{c.explanation && <p>{c.explanation}</p>}</div>
    {(c.triggeredRules.length > 0 || c.violatedRules.length > 0) && <div className="drawer-section"><span className="eyebrow">RULES</span>{c.triggeredRules.map((x: string) => <div className="drawer-rule" key={`t${x}`}><Check size={13} /> {x} near threshold</div>)}{c.violatedRules.map((x: string) => <div className="drawer-rule" key={`v${x}`}><X size={13} /> {x} <b>VIOLATED</b></div>)}</div>}
    <button className="button secondary full-width" onClick={onClose}>Close</button>
  </aside></div>
}

function Cliffs({ simId }: { simId: string }) {
  const res = useApi(() => api.cliffs(simId), [simId])
  const [idx, setIdx] = useState(0)
  if (res.error) return <ErrorBox message={res.error} />
  if (!res.data) return <Loading />
  const list: any[] = res.data
  if (!list.length) return <div className="panel"><p className="empty-state">No numeric thresholds to stress-test in this policy.</p></div>
  const c = list[Math.min(idx, list.length - 1)]
  return <div>{list.length > 1 && <div className="selector-row">{list.map((x, i) => <button key={x.id} className={i === idx ? 'active' : ''} onClick={() => setIdx(i)}>{x.variable.toUpperCase()}</button>)}</div>}
    <div className="cliffs-grid"><div className="panel cliff-panel"><SectionHeader title="Policy cliff detection"><StatusPill tone="earth">{c.severity} SEVERITY</StatusPill></SectionHeader><p className="panel-desc">{c.description}</p>
      <div className="cliff-lines">{c.dataPoints.map((d: any, i: number) => i === c.dataPoints.length - 1
        ? <div className="boundary" key={i}><b>{d.label}</b><span>{d.outcome}</span></div>
        : <div key={i}><b>{d.label}</b><span className="eligible-line">{d.outcome}</span></div>)}</div>
      <div className="boundary-label"><span /> POLICY BOUNDARY <span /></div></div>
    <div className="panel cliff-stats"><div><span className="eyebrow">THRESHOLD</span><strong>{c.thresholdValue}</strong></div><div><span className="eyebrow">CRITICAL CHANGE</span><strong>{c.criticalChange}</strong></div><div><span className="eyebrow">AFFECTED CASES</span><strong>{num(c.affectedCases)}</strong></div><div><span className="eyebrow">SEVERITY</span><StatusPill tone="earth">{c.severity}</StatusPill></div></div></div></div>
}

function Conflicts({ simId }: { simId: string }) {
  const res = useApi(() => api.conflicts(simId), [simId])
  const [idx, setIdx] = useState(0)
  if (res.error) return <ErrorBox message={res.error} />
  if (!res.data) return <Loading />
  const list: any[] = res.data
  if (!list.length) return <div className="panel"><p className="empty-state">No rule conflicts were detected in this run.</p></div>
  const c = list[Math.min(idx, list.length - 1)]
  const shorts: Record<string, string> = res.meta?.rules ?? {}
  const third = res.meta?.thirdRule
  return <div>{list.length > 1 && <div className="selector-row">{list.map((x, i) => <button key={x.id} className={i === idx ? 'active' : ''} onClick={() => setIdx(i)}>{x.conflictCode}</button>)}</div>}
    <div className="conflict-grid"><div className="panel conflict-graph"><SectionHeader title="Rule relationship graph"><span className="panel-caption">{list.length} CONFLICT{list.length === 1 ? '' : 'S'} DETECTED</span></SectionHeader>
      <div className="graph"><div className="graph-node">RULE {c.ruleACode} <small>{shorts[c.ruleACode]}</small></div><div className="graph-line" /><div className="graph-node">RULE {c.ruleBCode} <small>{shorts[c.ruleBCode]}</small></div><div className="graph-line split" /><div className="graph-alert">CONFLICT <small>{c.conflictType === 'MUTUALLY_EXCLUSIVE' ? 'Mutually exclusive' : 'Contradictory outcome'}</small></div>{third && <div className="graph-branches"><div className="graph-line" /><div className="graph-node">RULE {third.code} <small>{third.short}</small></div></div>}</div></div>
    <div className="panel conflict-detail"><span className="eyebrow sage-text">{c.conflictCode}</span><h3>{c.title}</h3><div className="conflict-row"><span>RULE A</span><b>{c.ruleACode} · {c.ruleADescription}</b></div><div className="conflict-row"><span>RULE B</span><b>{c.ruleBCode} · {c.ruleBDescription}</b></div><div className="conflict-row"><span>AFFECTED CASES</span><b>{num(c.affectedCases)} synthetic cases</b></div><div className="conflict-row"><span>STATUS</span><StatusPill tone="earth">{c.status.replace('_', ' ')}</StatusPill></div></div></div></div>
}

function Fairness({ simId }: { simId: string }) {
  const res = useApi(() => api.fairness(simId), [simId])
  if (res.error) return <ErrorBox message={res.error} />
  if (!res.data) return <Loading />
  const f = res.data
  return <div className="fairness-grid"><div className="panel fairness-panel"><SectionHeader title="Coverage by income band"><span className="panel-caption">SIMULATED / SYNTHETIC</span></SectionHeader><div className="coverage-chart">{f.bands.map((b: any) => <div className="chart-column" key={b.band}><div className="column-bar" style={{ height: `${b.height}%` }}><span>{b.height}%</span></div><small>{b.band}</small></div>)}</div></div>
    <div className="panel heat-panel"><SectionHeader title="Exclusion concentration"><StatusPill tone="muted">SYNTHETIC DATA</StatusPill></SectionHeader><div className="heatmap">{f.heatmap.map((v: number, i: number) => <i key={i} className={`heat-${v}`} />)}</div><div className="heat-legend"><span>Lower</span><i /><i /><i /><i /><i /><span>Higher</span></div></div>
    <div className="panel fairness-note"><span className="eyebrow sage-text">FAIRNESS INDICATOR</span><strong>{Math.round(f.score)} <small>/ 100</small></strong><p>{f.note}</p></div></div>
}

/* ───────────────────────── What-If Lab ───────────────────────── */
function WhatIf({ ctx, onExplain }: { ctx: Ctx; onExplain: () => void }) {
  const cfg = ctx.policy?.whatIf
  const sim = ctx.ov.data?.simulation
  const [val, setVal] = useState<number>(cfg?.default ?? 0)
  const [scenario, setScenario] = useState<string>(cfg?.prompt ?? '')
  const [nl, setNl] = useState<any>(null)
  const [nlBusy, setNlBusy] = useState(false)
  const [nlError, setNlError] = useState('')
  const dv = useDebounced(val, 250)
  const live = useApi(cfg && sim ? () => api.whatIf({ simulationId: sim.id, parameter: cfg.ruleCode, newValue: dv, explain: false }) : null, [sim?.id, cfg?.ruleCode, dv])

  if (ctx.ov.error) return <div className="page-content"><ErrorBox message={ctx.ov.error} onRetry={ctx.retry} /></div>
  if (!ctx.policy || !sim) return <div className="page-content"><Loading /></div>
  if (!cfg) return <div className="page-content"><div className="page-intro"><div><span className="eyebrow sage-text">COUNTERFACTUAL ANALYSIS / 04</span><h1>What-If Lab</h1><p>This policy has no numeric rule to adjust.</p></div></div></div>

  const w = nl ?? live.data
  const runNl = async () => {
    setNlBusy(true); setNlError('')
    try {
      const res = await api.whatIf({ simulationId: sim.id, scenario, explain: true })
      setNl(res.data)
      if (res.data.parameter === cfg.ruleCode && res.data.newValue >= cfg.min && res.data.newValue <= cfg.max) setVal(res.data.newValue)
    } catch (e) { setNlError(errMsg(e)) } finally { setNlBusy(false) }
  }
  const total = w ? w.baseline.eligible + w.baseline.rejected + w.baseline.review : sim.results.totalTested
  const delta = w?.eligibleDelta ?? 0
  const shownVal = w && w.newValue === val ? w.newFormatted : cfg.currentFormatted.startsWith('₹') ? `₹${Math.round(val).toLocaleString('en-IN')}` : String(val)
  const summary = !w ? '' : delta === 0 ? 'No change in eligibility.' : delta > 0 ? 'More people qualify.' : 'Fewer people qualify.'
  const rules: any[] = ctx.policy.currentVersion.rules
  const fallbackExplain = !w ? '' : delta === 0
    ? 'At this value no synthetic outcomes change, so the policy is not sensitive to this parameter in that range.'
    : `${delta > 0 ? 'Loosening' : 'Tightening'} this rule ${delta > 0 ? 'brings' : 'pushes'} ${num(Math.abs(delta))} synthetic cases ${delta > 0 ? 'into' : 'out of'} scope. The largest change occurs for applicants whose value lies between ${w.oldFormatted} and ${w.newFormatted}.`

  return <div className="page-content"><div className="page-intro"><div><span className="eyebrow sage-text">COUNTERFACTUAL ANALYSIS / 04</span><h1>What-If Lab</h1><p>Change the policy. See what happens.</p></div><StatusPill>{live.loading || nlBusy ? 'RUNNING SCENARIO' : 'SCENARIO READY'}</StatusPill></div>
    <div className="whatif-input panel"><div className="input-icon"><Sparkles size={18} /></div><div style={{ flex: 1, minWidth: 0 }}><span className="eyebrow">NATURAL LANGUAGE SCENARIO</span><input className="nl-input" aria-label="Natural language scenario" value={scenario} onChange={e => setScenario(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && scenario.trim() && !nlBusy) runNl() }} />{nlError && <p className="inline-note">{nlError}</p>}</div><button className="button primary" onClick={runNl} disabled={nlBusy || !scenario.trim()}>{nlBusy ? 'Running…' : 'Run What-If'} <ArrowRight size={15} /></button></div>
    {live.error && <ErrorBox message={live.error} />}
    <div className="whatif-main">
      <div className="panel slider-panel"><SectionHeader title="Adjust policy parameter"><span className="eyebrow">{ctx.policy.name}</span></SectionHeader><div className="slider-copy"><span>{cfg.shortLabel}</span><strong>{shownVal}</strong></div>
        <input aria-label={cfg.shortLabel} type="range" min={cfg.min} max={cfg.max} step={cfg.roundTo} value={val} onChange={e => { setNl(null); setVal(Number(e.target.value)) }} />
        <div className="slider-labels"><span>{cfg.minFormatted}</span><span>{cfg.maxFormatted}</span></div>
        <div className="parameter-list">{rules.slice(0, 4).map(r => <div key={r.id}><span>{r.shortLabel}</span><b>{typeof r.value === 'boolean' ? (r.value ? 'Required' : 'Not permitted') : `${r.operator} ${Number(r.value).toLocaleString('en-IN')}`}</b><ChevronRight size={14} /></div>)}</div></div>
      <div className="panel comparison-panel"><span className="eyebrow sage-text">SCENARIO OUTPUT / SIMULATED</span>{!w ? <Loading label="RUNNING SCENARIO" /> : <>
        <h2>{summary}</h2>
        <div className="comparison-grid"><div><span className="comparison-label">BEFORE</span><strong>{num(w.baseline.eligible)}</strong><small>ELIGIBLE</small><div className="mini-bar"><i style={{ width: `${(100 * w.baseline.eligible) / total}%` }} /></div><p>{num(w.baseline.rejected)} rejected</p></div><div className="comparison-arrow"><ArrowRight size={20} /></div><div className="after"><span className="comparison-label">AFTER</span><strong>{num(w.changed.eligible)}</strong><small>ELIGIBLE</small><div className="mini-bar"><i style={{ width: `${(100 * w.changed.eligible) / total}%` }} /></div><p>{num(w.changed.rejected)} rejected</p></div></div>
        <div className="impact-callout"><strong>{delta >= 0 ? '+' : '-'}{num(Math.abs(delta))} synthetic cases {delta >= 0 ? 'covered' : 'removed'}</strong><span>{w.budgetFormatted} estimated simulated budget impact</span></div></>}</div>
    </div>
    <div className="explain-panel"><div><span className="eyebrow">AI EXPLANATION</span><p>{w?.aiExplanation || fallbackExplain || 'Adjust the slider or run a scenario to see the impact.'}</p></div><button type="button" className="button secondary" onClick={onExplain}>Explain change <Sparkles size={15} /></button></div>
  </div>
}

/* ───────────────────────── Explain chat ───────────────────────── */
function ExplainChat({ onClose, simId }: { onClose: () => void; simId?: string }) {
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [messages, setMessages] = useState<{ role: string; text: string }[]>([{ role: 'assistant', text: 'I can explain EDGECASE findings, the simulation, and this audit report in plain language. What would you like to understand?' }])
  const sendMessage = async () => {
    const value = message.trim()
    if (!value || busy) return
    setMessages(cur => [...cur, { role: 'user', text: value }]); setMessage(''); setBusy(true)
    try { const res = await api.chat(value, simId); setMessages(cur => [...cur, { role: 'assistant', text: res.data.reply }]) }
    catch (e) { setMessages(cur => [...cur, { role: 'assistant', text: errMsg(e) }]) }
    finally { setBusy(false) }
  }
  return <div className="chat-overlay" role="dialog" aria-modal="true" aria-label="Explain EDGECASE"><div className="chat-panel"><div className="chat-header"><div><span className="eyebrow sage-text">EDGECASE EXPLAINER</span><h3>Understand this change</h3></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close explainer"><X size={17} /></button></div>
    <div className="chat-messages">{messages.map((item, index) => <div key={`${item.role}-${index}`} className={`chat-message ${item.role}`}>{item.text}</div>)}{busy && <div className="chat-message assistant thinking">Thinking…</div>}</div>
    <div className="chat-input"><input aria-label="Ask EDGECASE" value={message} onChange={event => setMessage(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) sendMessage() }} placeholder="Ask about cliffs, conflicts, fairness or this change" /><button type="button" className="button primary" onClick={sendMessage} disabled={busy}>Send</button></div></div></div>
}

/* ───────────────────────── Reports ───────────────────────── */
function Reports({ ctx }: { ctx: Ctx }) {
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [tick, setTick] = useState(0)
  const list = useApi(() => api.reports(ctx.slug), [ctx.slug, tick])
  const ov = ctx.ov.data
  const simId: string | undefined = ov?.simulation.id
  const reports: any[] = list.data ?? []
  const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase()

  const make = async (type: string) => { const res = await api.createReport(simId!, type); setTick(t => t + 1); return res.data }
  const generate = async (type: string, mode: 'download' | 'open' | 'new', label: string) => {
    if (!simId) return
    setBusy(label); setError(''); setNote('')
    const win = mode === 'open' ? window.open('', '_blank') : null   // open synchronously so popup blockers allow it
    try {
      const existing = mode !== 'new' ? reports.find(r => r.reportType === type && r.simulationId === simId) : null
      const rep = existing ?? await make(type)
      if (mode === 'open' && win) win.location.href = reportUrl(rep, true)
      else { const a = document.createElement('a'); a.href = reportUrl(rep); a.download = ''; document.body.appendChild(a); a.click(); a.remove() }
      setNote(mode === 'open' ? 'Report opened in a new tab. ' : 'Download started. ')
    } catch (e) { win?.close(); setError(errMsg(e)) } finally { setBusy('') }
  }
  const cards: [string, string, string, typeof BarChart3][] = [
    ['Simulation Report', `Crash-test results · ${num(ov?.simulation.results.totalTested ?? 100000)} cases`, 'SIMULATION_REPORT', BarChart3],
    ['Policy Version Comparison', 'Compare changes across versions', 'VERSION_COMPARISON', GitBranch],
    ['Rule Extraction Log', 'AI reasoning and confidence trail', 'RULE_EXTRACTION_LOG', ClipboardCheck],
  ]
  const [first, ...rest] = (ov?.policy.name ?? 'Policy').split(' ')
  return <div className="page-content"><div className="page-intro"><div><span className="eyebrow sage-text">AUDIT CENTER / 05</span><h1>Reports</h1><p>Professional records for every policy decision.</p></div><button className="button primary" disabled={!simId || !!busy} onClick={() => generate('AUDIT_REPORT', 'new', 'new')}><Plus size={15} /> {busy === 'new' ? 'Generating…' : 'Generate report'}</button></div>
    {ctx.ov.error && <ErrorBox message={ctx.ov.error} onRetry={ctx.retry} />}
    {error && <ErrorBox message={error} />}
    {!ov && !ctx.ov.error ? <Loading /> : ov && <>
      <div className="report-feature panel"><div className="report-cover"><span className="eyebrow">EDGECASE / POLICY AUDIT</span><div className="cover-mark"><Target size={32} /><span>EC</span></div><h2>{first}{rest.length > 0 && <><br />{rest.join(' ')}</>}</h2><span className="report-date">AUDIT REPORT · {today}</span></div>
        <div className="report-summary"><span className="eyebrow sage-text">LATEST AUDIT REPORT</span><h2>Policy Audit Report</h2><p>A complete analysis of rules, synthetic population outcomes, edge cases, cliffs, and counterfactual impact.</p><div className="summary-stats"><div><b>{pad2(ov.rulesCount)}</b><span>Rules extracted</span></div><div><b>{pad2(ov.simulation.results.edgeCaseCount).replace(/^(\d+)$/, (m: string) => Number(m).toLocaleString('en-US'))}</b><span>Edge cases</span></div><div><b>{Math.round(ov.simulation.results.fairnessScore)}/100</b><span>Fairness signal</span></div></div>
          <div className="report-actions"><button className="button primary" disabled={!!busy} onClick={() => generate('AUDIT_REPORT', 'open', 'view')}>{busy === 'view' ? 'Preparing…' : 'View report'} <ArrowRight size={15} /></button><button className="button secondary" disabled={!!busy} onClick={() => generate('AUDIT_REPORT', 'download', 'pdf')}><FileText size={15} /> {busy === 'pdf' ? 'Preparing…' : 'Download PDF'}</button></div></div></div>
      <div className="reports-grid">{cards.map(([title, subtitle, type, Icon]) => <div className="report-card panel" key={type}><div className="report-icon"><Icon size={18} /></div><h3>{title}</h3><p>{subtitle}</p><button className="text-button" disabled={!!busy} onClick={() => generate(type, 'open', type)}>{busy === type ? 'Preparing…' : 'Open report'} <ArrowRight size={14} /></button></div>)}</div>
      {reports.length > 0 && <div className="audit-note"><FileText size={16} /> {reports.length} report{reports.length === 1 ? '' : 's'} generated for this policy.</div>}
      <div className="audit-note"><Check size={16} /> {note}All reports include a synthetic data disclaimer and methodology appendix.</div></>}
  </div>
}

/* ───────────────────────── Shell ───────────────────────── */
export default function Page() {
  const [page, setPage] = useState<Page>('Overview')
  const [slug, setSlug] = useState(DEFAULT_SLUG)
  const [simId, setSimId] = useState<string | undefined>()
  const [pTick, setPTick] = useState(0)
  const [oTick, setOTick] = useState(0)
  const [mobileNav, setMobileNav] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)

  const pol = useApi(() => api.policies(), [pTick])
  const ov = useApi(() => api.overview(slug, simId), [slug, simId, oTick])
  const policies: any[] = pol.data ?? []
  const policy = policies.find(p => p.slug === slug)
  const selectPolicy = (s: string) => { setSlug(s); setSimId(undefined) }
  const ctx: Ctx = { ov, retry: () => { setOTick(t => t + 1); setPTick(t => t + 1) }, slug, simId, policy }
  const select = (
    <select value={slug} onChange={e => selectPolicy(e.target.value)}>
      {policies.length === 0 && <option value={slug}>{slug}</option>}
      {policies.map(p => <option key={p.slug} value={p.slug}>{p.name}</option>)}
    </select>
  )

  return <main className="app-shell"><aside className={`sidebar ${mobileNav ? 'open' : ''}`}><div className="brand"><div className="brand-symbol">+</div><div><strong>EDGECASE</strong><span>POLICY INTELLIGENCE</span></div><button className="mobile-close" onClick={() => setMobileNav(false)}><X size={18} /></button></div><div className="sidebar-label">WORKSPACE</div><nav>{navItems.map(({ label, icon: Icon }) => <button key={label} className={page === label ? 'active' : ''} onClick={() => { setPage(label); setMobileNav(false) }}><Icon size={17} />{label}{label === 'Simulation' && <span className="nav-count">●</span>}</button>)}</nav><div className="sidebar-bottom"><span>© 2026 EDGECASE SYSTEMS</span></div></aside>
    <div className="main-area"><header className="topbar"><button className="mobile-menu" onClick={() => setMobileNav(true)}><Menu size={20} /></button><div className="breadcrumbs"><span>EDGECASE</span><ChevronRight size={14} /><b>{page.toUpperCase()}</b></div></header>
      <div className="mobile-policy"><span>ACTIVE POLICY</span>{select}</div>
      {pol.error && <div className="page-content" style={{ paddingBottom: 0 }}><ErrorBox message={pol.error} onRetry={ctx.retry} /></div>}
      {page === 'Overview' && <Overview ctx={ctx} setPage={setPage} />}
      {page === 'Policy Lab' && <PolicyLab ctx={ctx} policies={policies} selectPolicy={selectPolicy} refreshPolicies={() => setPTick(t => t + 1)} setPage={setPage} />}
      {page === 'Simulation' && <Simulation ctx={ctx} setPage={setPage} onNewSim={setSimId} />}
      {page === 'What-If Lab' && <WhatIf key={slug} ctx={ctx} onExplain={() => setChatOpen(true)} />}
      {page === 'Reports' && <Reports ctx={ctx} />}
      {chatOpen && <ExplainChat onClose={() => setChatOpen(false)} simId={ov.data?.simulation.id} />}
    </div></main>
}
