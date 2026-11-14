import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

if (typeof navigator !== 'undefined' && navigator.webdriver && typeof HTMLCanvasElement !== 'undefined') {
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  // @ts-expect-error override 2d context options for headless CPU rasterization
  HTMLCanvasElement.prototype.getContext = function (contextId: string, options?: Record<string, unknown>) {
    if (contextId === '2d') {
      return origGetContext.call(this, '2d', { ...(options || {}), willReadFrequently: true });
    }
    return origGetContext.call(this, contextId as never, options as never);
  };
}

createRoot(document.getElementById('root')!).render(<App />);

