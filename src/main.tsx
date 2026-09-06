import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

if (new URLSearchParams(location.search).has('render')) {
  void import('./render').then(({ setupRenderPage }) => setupRenderPage());
} else {
  createRoot(document.getElementById('root')!).render(<App />);
}
