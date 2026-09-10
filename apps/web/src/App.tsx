import { NavLink, Route, Routes } from 'react-router-dom';
import { MatchList } from './pages/MatchList.js';
import { Viewer } from './pages/Viewer.js';
import { Workbench } from './pages/Workbench.js';
import { Rules } from './pages/Rules.js';

/** Four routes (web plan §8). No settings page, no profile, no upload form. */
export function App(): React.JSX.Element {
  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">SPARK</span>
        <nav>
          <NavLink to="/" className={({ isActive }) => (isActive ? 'on' : '')} end>
            matches
          </NavLink>
          <NavLink to="/workbench" className={({ isActive }) => (isActive ? 'on' : '')}>
            workbench
          </NavLink>
          <NavLink to="/rules" className={({ isActive }) => (isActive ? 'on' : '')}>
            rules
          </NavLink>
        </nav>
      </header>
      <Routes>
        <Route path="/" element={<MatchList />} />
        <Route path="/match/:id" element={<Viewer />} />
        <Route path="/workbench" element={<Workbench />} />
        <Route path="/rules" element={<Rules />} />
      </Routes>
    </div>
  );
}
