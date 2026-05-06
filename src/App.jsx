import { useState } from 'react';
import Home from './pages/Home.jsx';
import Host from './pages/Host.jsx';
import Client from './pages/Client.jsx';

export default function App() {
  const [screen, setScreen] = useState('home');

  if (screen === 'home') return <Home onPick={setScreen} />;
  if (screen === 'host') return <Host onLeave={() => setScreen('home')} />;
  if (screen === 'client') return <Client onLeave={() => setScreen('home')} />;
  return null;
}
