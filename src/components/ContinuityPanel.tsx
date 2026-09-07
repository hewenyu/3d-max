import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, EyeOff, LocateFixed, RefreshCw, RotateCcw } from 'lucide-react';
import {
  continuityRuleLabels,
  type ContinuityFinding,
  type ContinuityReport,
} from '../../shared/continuity-types';
import type { Project } from '../../shared/types';
import { IconButton } from './Controls';
import './continuity.css';

export function ContinuityPanel({
  project,
  loadReport,
  onNavigate,
  onIgnore,
}: {
  project: Project;
  loadReport: () => Promise<ContinuityReport>;
  onNavigate: (finding: ContinuityFinding) => void;
  onIgnore: (findingId: string, reason: string | null) => Promise<void>;
}) {
  const [report, setReport] = useState<ContinuityReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'open' | 'ignored' | 'all'>('open');
  const [selected, setSelected] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const request = useRef(0);
  const loader = useRef(loadReport);
  loader.current = loadReport;
  const refresh = useCallback(async () => {
    const generation = ++request.current;
    setLoading(true);
    setError('');
    try {
      const next = await loader.current();
      if (generation === request.current) setReport(next);
    } catch (error) {
      if (generation === request.current) setError((error as Error).message);
    } finally {
      if (generation === request.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    return () => {
      request.current++;
    };
  }, [project.id, project.revision, project.activeSequenceId, refresh]);
  const findings =
    report?.findings.filter((finding) => filter === 'all' || finding.ignored === (filter === 'ignored')) ??
    [];
  const current = report?.findings.find((finding) => finding.id === selected);
  const open = report?.findings.filter((finding) => !finding.ignored).length ?? 0;
  const updateIgnore = async () => {
    if (!current || (!current.ignored && !reason.trim())) return;
    setSaving(true);
    setError('');
    try {
      await onIgnore(current.id, current.ignored ? null : reason.trim());
      await refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const shotName = (id: string) => project.shots.find((shot) => shot.id === id)?.name ?? id;
  return (
    <section className="continuity-panel" aria-label="连续性检查">
      <div className="continuity-toolbar">
        <strong>连续性检查</strong>
        {report && (
          <span className="muted small">
            {open} 项待检查 · {report.sampledFrames} 帧
          </span>
        )}
        <span className="flex-spacer" />
        <select
          aria-label="连续性筛选"
          value={filter}
          onChange={(event) => setFilter(event.target.value as typeof filter)}
        >
          <option value="open">待检查</option>
          <option value="ignored">已忽略</option>
          <option value="all">全部</option>
        </select>
        <IconButton
          icon={RefreshCw}
          label="重新检查连续性"
          disabled={loading}
          onClick={() => void refresh()}
        />
      </div>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      {loading && (
        <div className="continuity-status" role="status">
          检查中...
        </div>
      )}
      {!loading && !findings.length && (
        <div className="continuity-status">
          <Check size={16} />
          {filter === 'ignored' ? '暂无忽略记录' : '当前筛选下没有问题'}
        </div>
      )}
      {findings.length > 0 && (
        <div className="continuity-table-scroll">
          <table className="continuity-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>镜头</th>
                <th>检查项</th>
                <th>结果</th>
                <th>
                  <span className="sr-only">定位</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {findings.map((finding) => (
                <tr key={finding.id} data-selected={selected === finding.id}>
                  <td className="mono">
                    {finding.sequenceTime.toFixed(2)}s
                    {finding.sequenceEndTime > finding.sequenceTime + 0.01
                      ? ` - ${finding.sequenceEndTime.toFixed(2)}s`
                      : ''}
                  </td>
                  <td>{shotName(finding.shotId)}</td>
                  <td>
                    <button
                      className="continuity-rule"
                      disabled={loading}
                      onClick={() => {
                        setSelected(finding.id);
                        setReason(finding.ignoreReason ?? '');
                      }}
                    >
                      {finding.ignored ? (
                        <EyeOff size={14} />
                      ) : (
                        <AlertTriangle
                          size={14}
                          className={finding.severity === 'error' ? 'continuity-error' : ''}
                        />
                      )}
                      {continuityRuleLabels[finding.rule]}
                    </button>
                  </td>
                  <td className="continuity-message">{finding.message}</td>
                  <td>
                    <IconButton
                      icon={LocateFixed}
                      label={`定位 ${continuityRuleLabels[finding.rule]}`}
                      disabled={loading || saving}
                      onClick={() => {
                        setSelected(finding.id);
                        setReason(finding.ignoreReason ?? '');
                        onNavigate(finding);
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {current && (
        <div className="continuity-detail">
          <div className="row">
            <strong>{continuityRuleLabels[current.rule]}</strong>
            <span className="muted small">源时间 {current.sourceTime.toFixed(3)}s</span>
          </div>
          {current.otherShotId && (
            <p className="small muted">
              {shotName(current.otherShotId)} → {shotName(current.shotId)}
            </p>
          )}
          <dl>
            {Object.entries(current.evidence).map(([key, value]) => (
              <div key={key}>
                <dt>{evidenceLabels[key] ?? key}</dt>
                <dd>{Array.isArray(value) ? value.join(', ') : value === null ? '无' : String(value)}</dd>
              </div>
            ))}
          </dl>
          <div className="continuity-ignore">
            {current.ignored ? (
              <span className="small">{current.ignoreReason}</span>
            ) : (
              <input
                aria-label="连续性忽略原因"
                placeholder="导演备注"
                value={reason}
                maxLength={2000}
                onChange={(event) => setReason(event.target.value)}
              />
            )}
            <button
              className="secondary-button"
              disabled={loading || saving || (!current.ignored && !reason.trim())}
              onClick={() => void updateIgnore()}
            >
              {current.ignored ? <RotateCcw size={14} /> : <EyeOff size={14} />}
              {current.ignored ? '恢复检查' : '标记为有意剪辑'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

const evidenceLabels: Record<string, string> = {
  beforeSideMeters: '前镜头轴距 / m',
  afterSideMeters: '后镜头轴距 / m',
  beforeNdcPerSecond: '前镜头水平速度',
  afterNdcPerSecond: '后镜头水平速度',
  beforeTargetId: '之前注视目标',
  afterTargetId: '当前注视目标',
  maxJointDisplacementMeters: '最大关节位移 / m',
  beforeSourceTime: '之前源时间 / s',
  afterSourceTime: '当前源时间 / s',
  beforeAction: '之前动作',
  afterAction: '当前动作',
  beforeOwnerId: '之前持有人',
  afterOwnerId: '当前持有人',
  beforeBone: '之前附着骨骼',
  afterBone: '当前附着骨骼',
  beforeVisible: '之前可见',
  afterVisible: '当前可见',
  cameraPosition: '摄影机位置 / m',
  previousCameraPosition: '之前机位 / m',
  test: '检测方式',
  geometry: '几何依据',
  visible: '可见状态',
  projectedCenter: '画面归一化坐标',
  blockedSamples: '遮挡采样点',
  testedSamples: '画内采样点',
  occluderIds: '遮挡对象',
  constraintId: '约束',
  effector: '接触骨骼',
  status: '状态',
  errorMeters: '接触误差 / m',
  target: '目标位置 / m',
  position: '实际位置 / m',
  reachable: '目标可达',
  beforeState: '前镜头状态标识',
};
