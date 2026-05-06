import { useState } from 'react';
import Home from './pages/Home.jsx';
import Host from './pages/Host.jsx';
import Client from './pages/Client.jsx';

export default function App() {
  const [screen, setScreen] = useState('home');

  return (
    <div className="app">
      <div className="topbar">
        <h1>GarenMovies</h1>
        {screen !== 'home' && (
          <button className="back-link" onClick={() => setScreen('home')}>← Retour</button>
        )}
      </div>
      <div className="content">
        {screen === 'home' && <Home onPick={setScreen} />}
        {screen === 'host' && <Host />}
        {screen === 'client' && <Client />}
      </div>
    </div>
  );
}
