import { useState } from 'react';
import Home from './pages/Home.jsx';
import Host from './pages/Host.jsx';
import Client from './pages/Client.jsx';
import UpdateModal from './components/UpdateModal.jsx';

export default function App() {
  const [screen, setScreen] = useState('home');

  return (
    <>
      {screen === 'home' && <Home onPick={setScreen} />}
      {screen === 'host' && <Host onLeave={() => setScreen('home')} />}
      {screen === 'client' && <Client onLeave={() => setScreen('home')} />}
      <UpdateModal />
    </>
  );
}
