import { Tv, Users } from 'lucide-react';

export default function Home({ onPick }) {
  return (
    <div className="app home-app">
      <div className="home">
        <h1 className="home-brand">GarenMovies</h1>
        <p className="home-tagline">
          Regardez vos films seul ou entre amis, où qu'ils soient.
          Lancez un film ou rejoignez le salon d'un proche.
        </p>
        <div className="home-actions">
          <button className="home-action" onClick={() => onPick('host')}>
            <div className="home-action-icon">
              <Tv size={20} strokeWidth={1.75} />
            </div>
            <h2 className="home-action-title">Regarder un film</h2>
            <p className="home-action-desc">
              Seul ou avec vos amis : lancez un film de votre disque dur et invitez qui vous voulez, partout dans le monde.
            </p>
          </button>
          <button className="home-action" onClick={() => onPick('client')}>
            <div className="home-action-icon">
              <Users size={20} strokeWidth={1.75} />
            </div>
            <h2 className="home-action-title">Rejoindre un salon</h2>
            <p className="home-action-desc">
              Connectez-vous au salon d'un ami pour regarder un film synchronisé.
            </p>
          </button>
        </div>
      </div>
    </div>
  );
}
