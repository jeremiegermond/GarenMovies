import { useState } from 'react';
import Home from './pages/Home.jsx';
import Host from './pages/Host.jsx';
import Client from './pages/Client.jsx';
import Solo from './pages/Solo.jsx';
import SoloBar from './pages/SoloBar.jsx';
import UpdateModal from './components/UpdateModal.jsx';
import WhatsNewModal from './components/WhatsNewModal.jsx';

export default function App() {
  const [screen, setScreen] = useState('home');

  // Separate frameless window that floats the solo controls over the native
  // mpv video in fullscreen (HTML can't overlay mpv, so it gets its own window).
  if (typeof window !== 'undefined' && window.location.hash === '#solobar') return <SoloBar />;

  return (
    <>
      {screen === 'home' && <Home onPick={setScreen} />}
      {screen === 'host' && <Host onLeave={() => setScreen('home')} />}
      {screen === 'client' && <Client onLeave={() => setScreen('home')} />}
      {screen === 'solo' && <Solo onLeave={() => setScreen('home')} />}
      <UpdateModal />
      <WhatsNewModal />
    </>
  );
}
