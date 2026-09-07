import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SequenceCompareDialog } from '../../src/components/SequenceCompareDialog';
import { ContinuityPanel } from '../../src/components/ContinuityPanel';
import { analyzeContinuity, applyContinuityCommand } from '../../shared/continuity';
import { Modal } from '../../src/components/Controls';
import type { Project } from '../../shared/types';

export function mountCompare(project: Project) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  root.render(
    <SequenceCompareDialog
      project={project}
      onClose={() => {
        root.unmount();
        container.remove();
      }}
    />,
  );
}

export function mountContinuity(project: Project) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  function Harness() {
    const [current, setCurrent] = useState(project);
    return (
      <Modal
        title="连续性验收"
        wide
        onClose={() => {
          root.unmount();
          container.remove();
        }}
      >
        <div className="modal-content">
          <ContinuityPanel
            project={current}
            loadReport={async () => analyzeContinuity(current, { sampleRate: 2 })}
            onNavigate={(finding) => {
              container.dataset.seek = String(finding.sequenceTime);
            }}
            onIgnore={async (findingId, reason) => {
              const next = structuredClone(current);
              applyContinuityCommand(next, 'continuity.ignore', { findingId, reason });
              next.revision++;
              setCurrent(next);
            }}
          />
        </div>
      </Modal>
    );
  }
  container.id = 'continuity-harness';
  root.render(<Harness />);
}
