import { ContinuityPanel } from './ContinuityPanel';
import { Modal } from './Controls';
import { api } from '../api';
import type { EditorActions } from '../useEditor';
import type { Project } from '../../shared/types';
import type { ContinuityFinding, ContinuityReport } from '../../shared/continuity-types';

export function ContinuityDialog({
  project,
  editor,
  onClose,
  onNavigate,
}: {
  project: Project;
  editor: EditorActions;
  onClose: () => void;
  onNavigate: (finding: ContinuityFinding) => void;
}) {
  return (
    <Modal title="连续性审查" onClose={onClose} wide>
      <ContinuityPanel
        project={project}
        loadReport={() =>
          api<ContinuityReport>('/continuity', {
            method: 'POST',
            body: JSON.stringify({
              projectId: project.id,
              expectedRevision: project.revision,
              sequenceId: project.activeSequenceId,
            }),
          })
        }
        onNavigate={onNavigate}
        onIgnore={async (findingId, reason) => {
          await editor.command('continuity.ignore', { findingId, reason }, { projectId: project.id });
        }}
      />
    </Modal>
  );
}
