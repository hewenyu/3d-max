import { useEffect, useState } from 'react';
import { Check, Film, LoaderCircle, Upload } from 'lucide-react';
import { api } from '../api';
import type { EditorActions } from '../useEditor';
import { Modal } from './Controls';
import { ProjectPackageControls } from './ProjectPackageControls';

interface ProjectSummary {
  id: string;
  name: string;
  sceneName: string;
  revision: number;
  updatedAt: string;
}

export function ProjectsDialog({
  editor,
  onClose,
  onImport,
}: {
  editor: EditorActions;
  onClose: () => void;
  onImport: () => void;
}) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    void api<ProjectSummary[]>('/projects')
      .then(setProjects)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  return (
    <Modal title="项目" onClose={onClose}>
      <div className="modal-content">
        {error && <div className="inline-error">{error}</div>}
        {loading && <LoaderCircle className="spin" />}
        <div className="project-list">
          {projects.map((project) => (
            <button
              key={project.id}
              className="project-list-item"
              onClick={() => {
                void editor.replace(`/projects/${project.id}/open`, {}).then((success) => {
                  if (success) onClose();
                });
              }}
            >
              <Film size={21} />
              <div>
                <strong>{project.name}</strong>
                <span>{project.sceneName}</span>
                <small>{new Date(project.updatedAt).toLocaleString('zh-CN')}</small>
              </div>
              {project.id === editor.project?.id && <Check size={16} className="success" />}
            </button>
          ))}
        </div>
        <button className="text-button full-width" onClick={onImport}>
          <Upload size={15} />
          导入项目文件
        </button>
        <ProjectPackageControls editor={editor} onImported={onClose} />
      </div>
    </Modal>
  );
}
